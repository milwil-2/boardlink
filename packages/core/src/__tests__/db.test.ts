import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectAurora } from "../aurora.js";
import { climbFrames, climbName, climbNames, defaultDbPath, defaultNamesPath } from "../db.js";

// Load node:sqlite the way db.ts does — via createRequire — because Vite's builtin list does not yet
// recognize the (experimental, Node 22+) node:sqlite specifier when statically imported.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function seed(conn: DatabaseSync): void {
  conn.exec("CREATE TABLE climbs (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, frames TEXT NOT NULL)");
  const insert = conn.prepare("INSERT INTO climbs (uuid, name, frames) VALUES (?, ?, ?)");
  insert.run("abc", "Crimpy", "p1r12");
  insert.run("def", "Slopey", "p2r13");
}

let dir: string;
let memDb: DatabaseSync;
let fileDb: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boardlink-db-"));
  memDb = new DatabaseSync(":memory:");
  seed(memDb);
  fileDb = join(dir, "tension.sqlite3");
  const w = new DatabaseSync(fileDb);
  seed(w);
  w.close();
});
afterEach(() => {
  memDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("db lookups", () => {
  it("batch-resolves known uuids and omits the unknown", () => {
    expect(climbNames(memDb, ["abc", "def", "missing"])).toEqual({ abc: "Crimpy", def: "Slopey" });
  });

  it("dedupes and drops blank/null uuids", () => {
    expect(climbNames(memDb, ["abc", "abc", "", null, undefined])).toEqual({ abc: "Crimpy" });
  });

  it("resolves a single name, undefined when unknown", () => {
    expect(climbName(memDb, "def")).toBe("Slopey");
    expect(climbName(memDb, "nope")).toBeUndefined();
  });

  it("resolves frames", () => {
    expect(climbFrames(memDb, ["abc"])).toEqual({ abc: "p1r12" });
  });

  it("accepts a file path (opened read-only)", () => {
    expect(climbNames(fileDb, ["abc"])).toEqual({ abc: "Crimpy" });
  });
});

describe("connectAurora tension name-fill from a db catalog", () => {
  const fakeSync = (body: unknown): typeof fetch =>
    (async (url: string | URL) =>
      String(url).endsWith("/sync")
        ? new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("", { status: 404 })) as unknown as typeof fetch;

  it("fills names from a db_path, leaving unknown climbs blank", async () => {
    const fetchFn = fakeSync({
      ascents: [
        { climbed_at: "2026-05-01 19:30:00", difficulty: 23, climb_uuid: "abc" },
        { climbed_at: "2026-05-02 10:00:00", difficulty: 20, climb_uuid: "missing" },
      ],
    });
    const res = await connectAurora("tension", { token: "tok" }, { fetch: fetchFn, dbPath: fileDb });
    const resolved = Object.fromEntries(res.ascents.map((a) => [a.raw!.climb_uuid, a.climbName]));
    expect(resolved).toEqual({ abc: "Crimpy", missing: "" });
  });

  it("leaves names blank without opt-in and with no cached catalog", async () => {
    // BOARDLINK_CACHE_DIR points at an empty temp dir, so the cached-catalog probe finds nothing and
    // no download is attempted.
    const prev = process.env.BOARDLINK_CACHE_DIR;
    process.env.BOARDLINK_CACHE_DIR = join(dir, "empty-cache");
    try {
      const fetchFn = fakeSync({
        ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 23, climb_uuid: "abc" }],
      });
      const res = await connectAurora("tension", { token: "tok" }, { fetch: fetchFn });
      expect(res.ascents[0]!.climbName).toBe("");
    } finally {
      if (prev === undefined) delete process.env.BOARDLINK_CACHE_DIR;
      else process.env.BOARDLINK_CACHE_DIR = prev;
    }
  });
});

describe("default cache paths", () => {
  const ENV_KEYS = ["BOARDLINK_CACHE_DIR", "XDG_CACHE_HOME"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("honors BOARDLINK_CACHE_DIR for both paths", () => {
    process.env.BOARDLINK_CACHE_DIR = dir;
    expect(defaultDbPath("tension")).toBe(join(dir, "tension.sqlite3"));
    expect(defaultNamesPath("tension")).toBe(join(dir, "tension-names.json"));
  });

  it("prefers BOARDLINK_CACHE_DIR over XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = join(dir, "xdg");
    process.env.BOARDLINK_CACHE_DIR = join(dir, "override");
    expect(defaultDbPath("tension")).toBe(join(dir, "override", "tension.sqlite3"));
  });

  it("uses XDG_CACHE_HOME when there is no override", () => {
    delete process.env.BOARDLINK_CACHE_DIR;
    process.env.XDG_CACHE_HOME = join(dir, "xdg");
    expect(defaultNamesPath("tension")).toBe(join(dir, "xdg", "boardlink", "tension-names.json"));
  });
});
