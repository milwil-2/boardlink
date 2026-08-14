import { describe, expect, it } from "vitest";
import { moonEntriesToAscents, type MoonEntry } from "../moon.js";
import { loadFixture, normalizeAll } from "./contract-helpers.js";

// MoonBoard golden-fixture contract test. Guards moonEntriesToAscents against backend
// response-shape drift, using the shared fixture the Python suite also consumes.
const fixture = loadFixture<MoonEntry[]>("moon");

describe("moonboard contract fixture", () => {
  it("maps the raw logbook entries to the golden normalized ascents", () => {
    expect(normalizeAll(moonEntriesToAscents(fixture.raw))).toEqual(fixture.expected);
  });

  it("drops projects and entries with unparseable or missing dates", () => {
    // Three raw entries (a project, an undated send, an unparseable date) must be dropped.
    const ascents = moonEntriesToAscents(fixture.raw);
    expect(fixture.raw.length).toBe(ascents.length + 3);
  });
});
