import { describe, expect, it } from "vitest";
import { parseVGrade } from "../grades.js";

describe("parseVGrade", () => {
  it("parses plain V-scale", () => {
    expect(parseVGrade("V5")).toBe(5);
    expect(parseVGrade("V10")).toBe(10);
    expect(parseVGrade("v3")).toBe(3);
  });

  it("parses a V token inside a compound Aurora label", () => {
    expect(parseVGrade("6C+/V5")).toBe(5);
    expect(parseVGrade("7A/V6")).toBe(6);
  });

  it("parses Font grades including the plus", () => {
    expect(parseVGrade("7A")).toBe(6);
    expect(parseVGrade("7A+")).toBe(7); // regression: the "+" must not be dropped
    expect(parseVGrade("6C+")).toBe(5);
    expect(parseVGrade("8A")).toBe(11);
  });

  it("returns undefined for junk / empty", () => {
    expect(parseVGrade("")).toBeUndefined();
    expect(parseVGrade(undefined)).toBeUndefined();
    expect(parseVGrade("project")).toBeUndefined();
  });
});
