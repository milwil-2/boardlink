import { describe, expect, it } from "vitest";
import { auroraSyncToAscents, type AuroraAscent } from "../aurora.js";
import { loadFixture, normalizeAll } from "./contract-helpers.js";

// Tension (Aurora) golden-fixture contract test. Guards auroraSyncToAscents against backend
// response-shape drift, using the shared fixture the Python suite also consumes.
const fixture = loadFixture<{ ascents: AuroraAscent[] }>("tension");

describe("tension contract fixture", () => {
  it("maps the raw sync response to the golden normalized ascents", () => {
    expect(normalizeAll(auroraSyncToAscents("tension", fixture.raw))).toEqual(fixture.expected);
  });

  it("drops unlisted and undated ascents", () => {
    // Two raw ascents (an unlisted one and one with no climbed_at) must be dropped.
    const ascents = auroraSyncToAscents("tension", fixture.raw);
    expect(fixture.raw.ascents.length).toBe(ascents.length + 2);
  });
});
