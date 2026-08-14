import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileNameCache } from "../cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boardlink-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FileNameCache", () => {
  it("round-trips and swaps the temp file away (atomic write)", () => {
    const path = join(dir, "names.json");
    new FileNameCache(path).setMany({ abc: "Crimpy" });
    expect(existsSync(`${path}.tmp`)).toBe(false); // temp file swapped away
    expect(new FileNameCache(path).getMany(["abc", "missing"])).toEqual({ abc: "Crimpy" });
  });

  it("treats a corrupt file as empty", () => {
    const path = join(dir, "names.json");
    writeFileSync(path, "{not json");
    expect(new FileNameCache(path).getMany(["abc"])).toEqual({});
  });

  it("treats a missing file as empty", () => {
    expect(new FileNameCache(join(dir, "absent.json")).getMany(["abc"])).toEqual({});
  });

  it("does not store misses (empty setMany leaves no file)", () => {
    const path = join(dir, "names.json");
    new FileNameCache(path).setMany({});
    expect(existsSync(path)).toBe(false);
  });

  it("merges across writes and preserves non-ASCII names literally on disk", () => {
    const path = join(dir, "names.json");
    const cache = new FileNameCache(path);
    cache.setMany({ a: "Café" });
    cache.setMany({ b: "Voie" });
    expect(new FileNameCache(path).getMany(["a", "b"])).toEqual({ a: "Café", b: "Voie" });
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("Café"); // JSON.stringify keeps the accented name literal
    expect(JSON.parse(text)).toEqual({ a: "Café", b: "Voie" });
  });
});
