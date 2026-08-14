import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import type { BoardSystem } from "./types.js";
import { BoardError } from "./types.js";

// The Aurora boards ship their whole climb catalog as assets/db.sqlite3 inside the Android APK.
// APKPure serves the latest build as a downloadable bundle (no account needed); extracting that
// sqlite lets us resolve climb_uuid -> name offline, so the sync's bare uuids never cost a per-climb
// API call. Aurora only: the current Kilter app left Aurora, and MoonBoard is a different app.
const APK_PACKAGES: Record<string, string> = {
  tension: "tensionboard2",
  kilter: "kilterboard", // legacy Aurora catalog; the live Kilter app is off Aurora now
};
const APKPURE = "https://d.apkpure.net/b/APK/com.auroraclimbing.{package}";
const DB_ENTRY = "assets/db.sqlite3";
// The bundle is ~100MB; allow a generous window but still fail rather than hang forever.
const TIMEOUT_MS = 180_000;
// APKPure 403s a request without a browser User-Agent.
const APK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

/** A catalog reference: either a path to open read-only, or an already-open connection to reuse. */
export type PathOrConn = string | DatabaseSync;

// node:sqlite is a Node built-in added in Node 22 (still flagged experimental). It is loaded lazily
// via createRequire so a runtime without it throws a clear, actionable BoardError instead of crashing
// at import time — and so callers that only use the web resolver never touch sqlite at all.
const nodeRequire = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | undefined;

function loadSqlite(): typeof import("node:sqlite") {
  if (!sqliteModule) {
    try {
      sqliteModule = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    } catch {
      throw new BoardError(
        "unexpected-response",
        "node:sqlite is unavailable; boardlink's offline catalog needs Node 22+ with the built-in " +
          'node:sqlite module. Upgrade Node, or resolve names via resolveNames: "web" instead.',
      );
    }
  }
  return sqliteModule;
}

function cacheDir(): string {
  // BOARDLINK_CACHE_DIR lets a deploy point the (global, static) catalog/name caches at a persistent
  // volume; without it we fall back to the XDG cache, then ~/.cache. Both catalog and name paths flow
  // through here, so one env var relocates the whole cache.
  const override = process.env.BOARDLINK_CACHE_DIR;
  if (override) return override;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "boardlink");
}

export function defaultDbPath(board: string): string {
  return join(cacheDir(), `${board}.sqlite3`);
}

export function defaultNamesPath(board: string): string {
  return join(cacheDir(), `${board}-names.json`);
}

// --- Minimal ZIP reader (zero-dep) ------------------------------------------
// APKs (and APKPure's XAPK bundles) are ZIP archives. Rather than pull in a zip library we parse the
// End-Of-Central-Directory record, walk the central directory, and inflate the one entry we want with
// node:zlib. Only the stored (0) and deflate (8) methods are supported — all an APK uses. No ZIP64
// (the ~100MB bundle stays well under the 4GB offsets a classic EOCD can address).

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/** Return the (decompressed) bytes of `name` inside `buf`, or null if the entry is absent. */
function zipFindEntry(buf: Buffer, name: string): Buffer | null {
  // Scan backwards for the EOCD signature (its 22-byte record may trail up to 64KB of comment).
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString("utf-8", p + 46, p + 46 + nameLen);
    if (entryName === name) return extractLocal(buf, localOffset, method, compSize);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function extractLocal(buf: Buffer, localOffset: number, method: number, compSize: number): Buffer {
  // Local file header is 30 bytes + name + extra; the name/extra lengths here can differ from the
  // central directory's, so re-read them from the local header before locating the data.
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return Buffer.from(data); // stored
  if (method === 8) return inflateRawSync(data); // deflate
  throw new Error(`unsupported zip compression method ${method}`);
}

function extractSqlite(bundle: Buffer, board: string): Buffer {
  // APKPure serves an XAPK/zip whose payload APK holds the sqlite; older single-APK bundles expose
  // assets/db.sqlite3 at the top level instead.
  const apkName = `com.auroraclimbing.${APK_PACKAGES[board]}.apk`;
  try {
    const apk = zipFindEntry(bundle, apkName);
    if (apk !== null) {
      const db = zipFindEntry(apk, DB_ENTRY);
      if (db === null) throw new Error("apk missing catalog entry");
      return db;
    }
    const direct = zipFindEntry(bundle, DB_ENTRY);
    if (direct !== null) return direct;
  } catch {
    throw new BoardError(
      "unexpected-response",
      "could not extract catalog from APK bundle",
      board as BoardSystem,
    );
  }
  throw new BoardError(
    "unexpected-response",
    "APK bundle did not contain the climb catalog",
    board as BoardSystem,
  );
}

/**
 * Download the board's APK and extract its bundled sqlite catalog to a gitignored cache path.
 * Cache-first: an existing file is reused unless `force`. Returns the catalog path.
 */
export async function downloadBoardDb(board: string, dest?: string, force = false): Promise<string> {
  if (!(board in APK_PACKAGES)) {
    throw new BoardError("unexpected-response", `no bundled catalog for board: ${board}`, board as BoardSystem);
  }
  const target = dest ?? defaultDbPath(board);
  if (existsSync(target) && !force) return target;

  let res: Response;
  try {
    const url = `${APKPURE.replace("{package}", APK_PACKAGES[board]!)}?version=latest`;
    res = await fetch(url, { headers: { "User-Agent": APK_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new BoardError("unreachable", "could not reach the APK source", board as BoardSystem);
  }
  if (!res.ok) {
    throw new BoardError("unexpected-response", `APK download failed (${res.status})`, board as BoardSystem);
  }
  const data = extractSqlite(Buffer.from(await res.arrayBuffer()), board);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target); // atomic, so an interrupted write never leaves a partial cached catalog
  return target;
}

/** Open the catalog read-only, so a lookup can never mutate the cached snapshot. */
export function openBoardDb(path: string): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  return new DatabaseSync(path, { readOnly: true });
}

function withConn<T>(pathOrConn: PathOrConn, fn: (conn: DatabaseSync) => T): T {
  if (typeof pathOrConn === "string") {
    const conn = openBoardDb(pathOrConn);
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  }
  return fn(pathOrConn);
}

function resolveColumn(
  conn: DatabaseSync,
  uuids: Iterable<string | null | undefined>,
  column: string,
): Record<string, string> {
  // Dedupe while preserving order, drop blanks; nothing to query if empty.
  const uniq = [...new Set(uuids)].filter((u): u is string => !!u);
  const out: Record<string, string> = {};
  if (uniq.length === 0) return out;
  // SQLite caps a statement at 999 host parameters; chunk to stay under it.
  for (let i = 0; i < uniq.length; i += 900) {
    const chunk = uniq.slice(i, i + 900);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = conn
      .prepare(`SELECT uuid, ${column} FROM climbs WHERE uuid IN (${placeholders})`)
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) out[row.uuid as string] = row[column] as string;
  }
  return out;
}

/** Batch-resolve climb_uuid -> name from the `climbs` table. Unknown uuids are absent. */
export function climbNames(
  pathOrConn: PathOrConn,
  uuids: Iterable<string | null | undefined>,
): Record<string, string> {
  return withConn(pathOrConn, (conn) => resolveColumn(conn, uuids, "name"));
}

export function climbName(pathOrConn: PathOrConn, uuid: string): string | undefined {
  return climbNames(pathOrConn, [uuid])[uuid];
}

/** Batch-resolve climb_uuid -> frames (the p<placement>r<role> layout string). */
export function climbFrames(
  pathOrConn: PathOrConn,
  uuids: Iterable<string | null | undefined>,
): Record<string, string> {
  return withConn(pathOrConn, (conn) => resolveColumn(conn, uuids, "frames"));
}
