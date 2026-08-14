import { AURORA_HOSTS, AURORA_UA } from "./aurora.js";
import { FileNameCache } from "./cache.js";
import type { NameCache } from "./cache.js";
import { defaultNamesPath } from "./db.js";
import type { BoardSystem } from "./types.js";
import { BoardError } from "./types.js";

// Each Aurora board serves a public, unauthenticated page per climb at <web_host>/climbs/<uuid> whose
// climb name sits in both the <title> and <h1>. Scraping it resolves names one climb at a time - no
// ~87MB catalog download, just N small requests. Names are static, so a resolved name is cached
// forever; misses are not cached, since an unlisted climb can be published later.
const WEB_HOSTS: Record<string, string> = { tension: AURORA_HOSTS.tension };
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const TIMEOUT_MS = 15_000;

// The common named HTML entities; anything else falls through to numeric decoding. Climb names rarely
// carry more than an ampersand, but this keeps parity with Python's html.unescape for the usual cases.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  eacute: "é",
  egrave: "è",
  agrave: "à",
};

function htmlUnescape(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    const rep = NAMED_ENTITIES[ent];
    return rep !== undefined ? rep : m;
  });
}

function extractName(page: string): string | null {
  for (const re of [TITLE_RE, H1_RE]) {
    const m = re.exec(page);
    if (m) {
      const name = htmlUnescape(m[1]!).trim();
      if (name) return name;
    }
  }
  return null;
}

async function fetchName(
  doFetch: typeof fetch,
  host: string,
  uuid: string,
  timeout: number,
): Promise<string | null> {
  let res: Response;
  try {
    res = await doFetch(`${host}/climbs/${encodeURIComponent(uuid)}`, {
      headers: { "User-Agent": AURORA_UA, accept: "text/html" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return null; // transient/unreachable: leave unresolved rather than fail the whole run
  }
  if (res.status !== 200) return null; // 404 for unlisted/deleted climbs; anything non-200 stays blank
  return extractName(await res.text());
}

/** Options for {@link resolveClimbNames}. `cache` takes precedence over `cachePath`. */
export interface ResolveNamesOptions {
  /** Any {@link NameCache} (e.g. a Redis/DB-backed store for a deploy). Wins over `cachePath`. */
  cache?: NameCache;
  /** Path for the default {@link FileNameCache} when no `cache` is given. */
  cachePath?: string;
  /**
   * Injected fetch reused across the whole batch — the TS analogue of Python's shared requests
   * Session. Lets tests mock HTTP and lets a deploy route through a proxy. Defaults to global fetch.
   */
  session?: typeof fetch;
  /** Per-request timeout in ms. */
  timeout?: number;
}

/**
 * Resolve climb_uuid -> name by scraping each climb's public web page, cache-first.
 *
 * Reads the name cache, fetches only the uuids not already cached (sequentially, reusing one fetch),
 * and persists the newly resolved names. Returns the resolved subset (cached + newly fetched);
 * unresolved uuids are simply absent. Never rejects on a fetch failure - a 404 or unreachable climb
 * just stays blank and is not cached.
 */
export async function resolveClimbNames(
  board: string,
  uuids: Iterable<string | null | undefined>,
  opts: ResolveNamesOptions = {},
): Promise<Record<string, string>> {
  const host = WEB_HOSTS[board];
  if (!host) {
    throw new BoardError("unexpected-response", `no web catalog for board: ${board}`, board as BoardSystem);
  }
  const store: NameCache = opts.cache ?? new FileNameCache(opts.cachePath ?? defaultNamesPath(board));
  const doFetch = opts.session ?? fetch;
  const timeout = opts.timeout ?? TIMEOUT_MS;

  const uniq = [...new Set(uuids)].filter((u): u is string => !!u);
  const resolved: Record<string, string> = { ...(await store.getMany(uniq)) };
  const missing = uniq.filter((u) => !(u in resolved));
  if (missing.length === 0) return resolved;

  const fetched: Record<string, string> = {};
  for (const uuid of missing) {
    const name = await fetchName(doFetch, host, uuid, timeout);
    if (name) fetched[uuid] = name;
  }

  if (Object.keys(fetched).length > 0) {
    await store.setMany(fetched);
    Object.assign(resolved, fetched);
  }
  return resolved;
}
