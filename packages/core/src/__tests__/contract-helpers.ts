// Helpers for the golden-fixture contract tests. The fixtures under <repo>/fixtures/*.json are
// shared verbatim with the Python suite so both parsers are held to the same normalized output.
// Each fixture holds the raw backend response and the expected list of normalized ascents (camelCase,
// public fields only — `raw` is an escape hatch and is intentionally out of the golden comparison).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Ascent } from "../types.js";

export interface Fixture<Raw = unknown> {
  description: string;
  raw: Raw;
  expected: NormalizedAscent[];
}

export interface NormalizedAscent {
  board: string;
  climbName: string | null;
  date: string | null;
  grade: string | null;
  userGrade: string | null;
  vGrade: number | null;
  tries: number | null;
  angle: number | null;
  isBenchmark: boolean;
  isMirror: boolean;
  isRepeat: boolean;
  comment: string | null;
}

export function loadFixture<Raw = unknown>(name: string): Fixture<Raw> {
  const path = fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture<Raw>;
}

// Project a produced Ascent onto the shared contract shape. `undefined` becomes `null` (JSON's
// absent value); the three boolean flags are coerced so a missing flag and Python's defaulted False
// compare equal.
export function normalize(a: Ascent): NormalizedAscent {
  return {
    board: a.board,
    climbName: a.climbName ?? null,
    date: a.date ?? null,
    grade: a.grade ?? null,
    userGrade: a.userGrade ?? null,
    vGrade: a.vGrade ?? null,
    tries: a.tries ?? null,
    angle: a.angle ?? null,
    isBenchmark: Boolean(a.isBenchmark),
    isMirror: Boolean(a.isMirror),
    isRepeat: Boolean(a.isRepeat),
    comment: a.comment ?? null,
  };
}

export function normalizeAll(ascents: Ascent[]): NormalizedAscent[] {
  return ascents.map(normalize);
}
