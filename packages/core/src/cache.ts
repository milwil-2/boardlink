import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Climb names are global, static data (not per-user), so one shared backing store safely serves every
// user of an app. The default is a JSON file, but a deploy (serverless, multi-worker) can swap in a
// Redis/DB/S3-backed store by supplying any object satisfying this interface. Resolution happens in
// batches, so the interface is batch-shaped to keep round-trips to one per resolve. Methods may return
// synchronously (FileNameCache) or a Promise (an async store) — callers await either.

export interface NameCache {
  /** Return the subset of `keys` that are cached, as `{key: name}`. Unknown keys are absent. */
  getMany(keys: string[]): Record<string, string> | Promise<Record<string, string>>;
  /** Persist newly resolved `{key: name}` entries. */
  setMany(mapping: Record<string, string>): void | Promise<void>;
}

/**
 * Default `NameCache`: a single JSON file, `{uuid: name}`.
 *
 * Reads tolerate a missing or corrupt file (treated as empty). Writes are atomic (temp + rename) so an
 * interrupted or concurrent write never leaves a partial file. `JSON.stringify` keeps non-ASCII climb
 * names literal on disk. Only resolved names are ever stored; misses are not.
 */
export class FileNameCache implements NameCache {
  constructor(public readonly path: string) {}

  private load(): Record<string, string> {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      return {}; // missing or corrupt cache is treated as empty
    }
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, string>)
      : {};
  }

  getMany(keys: string[]): Record<string, string> {
    const cache = this.load();
    const out: Record<string, string> = {};
    for (const k of keys) if (k in cache) out[k] = cache[k]!;
    return out;
  }

  setMany(mapping: Record<string, string>): void {
    if (Object.keys(mapping).length === 0) return; // set_many({}) is a no-op: a miss leaves no file
    // Re-read before merge so a concurrent writer's entries are not clobbered.
    const cache = this.load();
    Object.assign(cache, mapping);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, this.path); // atomic, so an interrupted write never corrupts the cache
  }
}

// A deploy backs names with its own store by implementing the same two methods, e.g. Redis:
//
//     class RedisNameCache implements NameCache {
//       constructor(private client, private prefix = "boardlink:names:") {}
//       async getMany(keys) {
//         const vals = await this.client.mget(keys.map((k) => this.prefix + k));
//         return Object.fromEntries(keys.map((k, i) => [k, vals[i]]).filter(([, v]) => v != null));
//       }
//       async setMany(mapping) {
//         const entries = Object.entries(mapping);
//         if (entries.length) await this.client.mset(Object.fromEntries(entries.map(([k, v]) => [this.prefix + k, v])));
//       }
//     }
//
// then pass it as `resolveClimbNames(..., { cache: new RedisNameCache(r) })`.
