import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AURORA_UA } from "../aurora.js";
import { connectAurora } from "../aurora.js";
import type { NameCache } from "../cache.js";
import { resolveClimbNames } from "../webnames.js";

// Minimal stand-in for a scraped climb page; the name lives in <title> and <h1>.
const PAGES: Record<string, string> = {
  abc: "<html><head><title>Duroxmanie 2.0</title></head><body><h1>Duroxmanie 2.0</h1></body></html>",
  esc: "<html><head><title>Rock &amp; Roll</title></head></html>",
  h1only: "<html><head></head><body><h1>Only In H1</h1></body></html>",
};

/** A fake fetch that records every GET so a test can assert the network was (not) hit; serves PAGES, else 404. */
function fakeSession(seen?: { ua?: string }): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const uuid = decodeURIComponent(u.slice(u.lastIndexOf("/") + 1));
    calls.push(uuid);
    if (seen) seen.ua = new Headers(init?.headers).get("User-Agent") ?? undefined;
    const page = PAGES[uuid];
    return page !== undefined ? new Response(page, { status: 200 }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boardlink-webnames-"));
  cachePath = join(dir, "tension-names.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveClimbNames (mocked HTTP)", () => {
  it("extracts the name from <title>", async () => {
    const s = fakeSession();
    expect(await resolveClimbNames("tension", ["abc"], { cachePath, session: s.fetch })).toEqual({
      abc: "Duroxmanie 2.0",
    });
  });

  it("falls back to <h1> when there is no title", async () => {
    const s = fakeSession();
    expect(await resolveClimbNames("tension", ["h1only"], { cachePath, session: s.fetch })).toEqual({
      h1only: "Only In H1",
    });
  });

  it("unescapes HTML entities", async () => {
    const s = fakeSession();
    expect(await resolveClimbNames("tension", ["esc"], { cachePath, session: s.fetch })).toEqual({
      esc: "Rock & Roll",
    });
  });

  it("leaves a 404 blank and does not cache it", async () => {
    const s1 = fakeSession();
    expect(await resolveClimbNames("tension", ["gone"], { cachePath, session: s1.fetch })).toEqual({});
    // A miss must not be cached: a later publish should be re-fetched, not remembered as blank.
    const s2 = fakeSession();
    await resolveClimbNames("tension", ["gone"], { cachePath, session: s2.fetch });
    expect(s2.calls).toEqual(["gone"]);
  });

  it("serves a cache hit without touching the network", async () => {
    const s1 = fakeSession();
    await resolveClimbNames("tension", ["abc"], { cachePath, session: s1.fetch });
    expect(s1.calls).toEqual(["abc"]);
    const s2 = fakeSession();
    expect(await resolveClimbNames("tension", ["abc"], { cachePath, session: s2.fetch })).toEqual({
      abc: "Duroxmanie 2.0",
    });
    expect(s2.calls).toEqual([]); // served entirely from the persisted cache
  });

  it("fetches only the uuids not already cached", async () => {
    const s1 = fakeSession();
    await resolveClimbNames("tension", ["abc"], { cachePath, session: s1.fetch });
    const s2 = fakeSession();
    await resolveClimbNames("tension", ["abc", "esc"], { cachePath, session: s2.fetch });
    expect(s2.calls).toEqual(["esc"]); // "abc" cached; only "esc" hits the network
  });

  it("treats a corrupt cache file as empty", async () => {
    writeFileSync(cachePath, "{not json");
    const s = fakeSession();
    expect(await resolveClimbNames("tension", ["abc"], { cachePath, session: s.fetch })).toEqual({
      abc: "Duroxmanie 2.0",
    });
  });

  it("sends the Aurora User-Agent on each fetch", async () => {
    const seen: { ua?: string } = {};
    const s = fakeSession(seen);
    await resolveClimbNames("tension", ["abc"], { cachePath, session: s.fetch });
    expect(seen.ua).toBe(AURORA_UA);
  });

  it("dedupes and drops blank uuids before fetching", async () => {
    const s = fakeSession();
    await resolveClimbNames("tension", ["abc", "abc", "", null, undefined], {
      cachePath,
      session: s.fetch,
    });
    expect(s.calls).toEqual(["abc"]);
  });

  it("rejects an unknown board", async () => {
    await expect(resolveClimbNames("moonboard", ["abc"], { cachePath })).rejects.toMatchObject({
      code: "unexpected-response",
    });
  });
});

// --- injected NameCache (protocol) ------------------------------------------

/** In-memory NameCache; records batch calls so a test can assert the interface is exercised. */
class MemoryNameCache implements NameCache {
  store: Record<string, string>;
  getCalls: string[][] = [];
  setCalls: Record<string, string>[] = [];
  constructor(seed?: Record<string, string>) {
    this.store = { ...(seed ?? {}) };
  }
  getMany(keys: string[]): Record<string, string> {
    this.getCalls.push([...keys]);
    const out: Record<string, string> = {};
    for (const k of keys) if (k in this.store) out[k] = this.store[k]!;
    return out;
  }
  setMany(mapping: Record<string, string>): void {
    this.setCalls.push({ ...mapping });
    Object.assign(this.store, mapping);
  }
}

describe("resolveClimbNames with an injected NameCache", () => {
  it("uses getMany and setMany", async () => {
    const cache = new MemoryNameCache();
    const s = fakeSession();
    const result = await resolveClimbNames("tension", ["abc"], { cache, session: s.fetch });
    expect(result).toEqual({ abc: "Duroxmanie 2.0" });
    expect(cache.getCalls).toEqual([["abc"]]);
    expect(cache.setCalls).toEqual([{ abc: "Duroxmanie 2.0" }]);
  });

  it("skips the network on a cache hit", async () => {
    const cache = new MemoryNameCache({ abc: "Duroxmanie 2.0" });
    const s = fakeSession();
    const result = await resolveClimbNames("tension", ["abc"], { cache, session: s.fetch });
    expect(result).toEqual({ abc: "Duroxmanie 2.0" });
    expect(s.calls).toEqual([]); // entirely from cache
    expect(cache.setCalls).toEqual([]); // nothing new to persist
  });

  it("fetches only the missing uuids", async () => {
    const cache = new MemoryNameCache({ abc: "Duroxmanie 2.0" });
    const s = fakeSession();
    const result = await resolveClimbNames("tension", ["abc", "esc"], { cache, session: s.fetch });
    expect(result).toEqual({ abc: "Duroxmanie 2.0", esc: "Rock & Roll" });
    expect(s.calls).toEqual(["esc"]);
    expect(cache.setCalls).toEqual([{ esc: "Rock & Roll" }]);
  });

  it("takes precedence over cachePath (the path file is never written)", async () => {
    const cache = new MemoryNameCache();
    const s = fakeSession();
    await resolveClimbNames("tension", ["abc"], { cache, cachePath, session: s.fetch });
    expect(cache.store).toEqual({ abc: "Duroxmanie 2.0" });
    const fresh = fakeSession();
    // If the file had been written, this would be a cache hit with no network call.
    await resolveClimbNames("tension", ["abc"], { cachePath, session: fresh.fetch });
    expect(fresh.calls).toEqual(["abc"]);
  });
});

describe("connectAurora tension web wiring", () => {
  const syncBody = {
    ascents: [
      { climbed_at: "2026-05-01 19:30:00", difficulty: 23, climb_uuid: "abc" },
      { climbed_at: "2026-05-02 10:00:00", difficulty: 20, climb_uuid: "gone" },
    ],
  };

  it("fills names from the web resolver, leaving unresolved climbs blank", async () => {
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/sync")) {
        return new Response(JSON.stringify(syncBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const uuid = decodeURIComponent(u.slice(u.lastIndexOf("/") + 1));
      const page = PAGES[uuid];
      return page !== undefined ? new Response(page, { status: 200 }) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const cache = new MemoryNameCache();
    const res = await connectAurora(
      "tension",
      { token: "tok" },
      { fetch: fetchFn, resolveNames: "web", cache },
    );
    const resolved = Object.fromEntries(res.ascents.map((a) => [a.raw!.climb_uuid, a.climbName]));
    expect(resolved).toEqual({ abc: "Duroxmanie 2.0", gone: "" });
  });
});
