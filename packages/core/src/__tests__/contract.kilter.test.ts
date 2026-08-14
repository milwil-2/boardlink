import { describe, expect, it } from "vitest";
import { kilterLogToAscent, type KilterLog } from "../kilter.js";
import { loadFixture, normalizeAll } from "./contract-helpers.js";

// Kilter golden-fixture contract test. Guards kilterLogToAscent + connectKilter's topped filter
// against backend response-shape drift, using the shared fixture the Python suite also consumes.
const fixture = loadFixture<KilterLog[]>("kilter");

// Mirror connectKilter: keep every log except the ones explicitly not topped, then map.
const parse = (raw: KilterLog[]) => raw.filter((l) => l.topped !== false).map(kilterLogToAscent);

describe("kilter contract fixture", () => {
  it("maps the raw logbook to the golden normalized ascents", () => {
    expect(normalizeAll(parse(fixture.raw))).toEqual(fixture.expected);
  });

  it("drops entries that are not topped", () => {
    // One raw entry (the unsent project, topped false) must be filtered out.
    expect(fixture.raw.length).toBe(fixture.expected.length + 1);
  });

  it("passes the source record through on raw", () => {
    expect(parse(fixture.raw)[0]!.raw).toBe(fixture.raw[0]);
  });
});
