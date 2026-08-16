import type { Ascent, BoardAuth, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { parseVGrade } from "./grades.js";

// MoonBoard's own web logbook API (a cookie/CSRF session at moonboard.com) has been decommissioned;
// its live connector is retired below (see the issue link). The pure mappers here are I/O-free and
// still guarded by the golden-fixture contract test, so they stay.

// Physical MoonBoard configurations and their logbook setup ids, kept for reference by the mappers
// and any future connector.
export const MOON_BOARD_IDS: Record<string, number> = {
  "MoonBoard 2016": 1,
  "MoonBoard Masters 2017": 15,
  "MoonBoard Masters 2019": 17,
  "MoonBoard 2020": 19,
  "MoonBoard 2024": 21,
};

const MOON_ANGLE = 40;
const PAGE_SIZE = 40;

export function logbookBody(setupId: number, page: number, pageSize = PAGE_SIZE): string {
  const data: Record<string, string> = {
    sort: "",
    page: String(page),
    pageSize: String(pageSize),
    group: "",
    filter: `setupId~eq~'${setupId}'`,
  };
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// Reads a named hidden input's value from the login HTML, tolerant of attribute order.
export function extractInputValue(html: string, name: string): string | undefined {
  const re1 = new RegExp(`name=["']${name}["'][^>]*?value=["']([^"']+)["']`, "i");
  const re2 = new RegExp(`value=["']([^"']+)["'][^>]*?name=["']${name}["']`, "i");
  return html.match(re1)?.[1] ?? html.match(re2)?.[1];
}

export function loginFormBody(
  username: string,
  password: string,
  verificationToken: string,
  formKey: string,
): string {
  const data: Record<string, string> = {
    "Login.Username": username,
    "Login.Password": password,
    __RequestVerificationToken: verificationToken,
    form_key: formKey,
  };
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

const ATTEMPTS_TO_TRIES: Record<string, number | null> = {
  Flashed: 1,
  "2nd try": 2,
  "3rd try": 3,
  "more than 3 tries": 4,
  Project: null, // logged but not sent
};

export function parseMoonTries(label: string | undefined): number | null {
  if (!label) return 1;
  return label in ATTEMPTS_TO_TRIES ? ATTEMPTS_TO_TRIES[label]! : 1;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "15 Nov 2023" -> "2023-11-15"
export function parseMoonDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return undefined;
  const mm = MONTHS[m[2]!.toLowerCase()];
  if (!mm) return undefined;
  return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
}

export interface MoonEntry {
  Id?: number;
  DateClimbedAsString?: string;
  NumberOfTries?: string;
  Comment?: string;
  Problem?: {
    Name?: string;
    Grade?: string; // consensus Font grade, e.g. "7A+"
    UserGrade?: string;
    IsBenchmark?: boolean;
  };
}

export function moonEntryToAscent(entry: MoonEntry): Ascent | null {
  const date = parseMoonDate(entry.DateClimbedAsString);
  if (!date) return null;
  const tries = parseMoonTries(entry.NumberOfTries);
  if (tries === null) return null; // project, not a send
  const p = entry.Problem ?? {};
  const grade = p.Grade || undefined;
  const userGrade = p.UserGrade || p.Grade || undefined;
  return {
    board: "moonboard",
    climbName: p.Name ?? "",
    date,
    grade,
    userGrade,
    vGrade: parseVGrade(grade ?? userGrade),
    tries,
    angle: MOON_ANGLE,
    isBenchmark: p.IsBenchmark ?? false,
    isMirror: false,
    isRepeat: false,
    comment: entry.Comment?.trim() || undefined,
    raw: entry as unknown as Record<string, unknown>,
  };
}

export function moonEntriesToAscents(entries: MoonEntry[]): Ascent[] {
  const out: Ascent[] = [];
  for (const e of entries) {
    const a = moonEntryToAscent(e);
    if (a) out.push(a);
  }
  return out;
}

// MoonBoard support is temporarily removed. Its web logbook API (the cookie/CSRF flow this file's
// pure helpers were built for) was decommissioned, and the Moon Climbing app's replacement backend
// is gated by Firebase App Check / Apple App Attest, which a third-party client cannot satisfy.
// The mappers above are kept because the golden-fixture contract test still exercises them and a
// future connector will likely reuse the Ascent shape. See:
//   https://github.com/milwil-2/boardlink/issues/1
const RETIRED_MESSAGE =
  "MoonBoard support is temporarily unavailable: its web API was decommissioned and the new app " +
  "backend is gated by Apple App Attest. Track re-enablement at " +
  "https://github.com/milwil-2/boardlink/issues/1";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function connectMoonboard(_auth: BoardAuth, _opts: ConnectOptions = {}): Promise<ConnectResult> {
  throw new BoardError("retired", RETIRED_MESSAGE, "moonboard");
}
