import type { Ascent, BoardAuth, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { parseVGrade } from "./grades.js";
import { addSetCookies, DEFAULT_UA, jarFromHeader, jarToHeader, type CookieJar } from "./http.js";

/**
 * MoonBoard has its own backend (NOT Aurora): a cookie/CSRF session login at moonboard.com, then a
 * paginated logbook API filtered by board "setup" id. The pure functions below are I/O-free and
 * unit-tested; {@link connectMoonboard} runs the cookie-jar handshake and returns normalized ascents
 * plus a reusable token (the serialized cookie jar).
 */

export const MOON_HOST = "https://moonboard.com";

/** Physical MoonBoard configurations -> their logbook `setupId`. We sweep all per user. */
export const MOON_BOARD_IDS: Record<string, number> = {
  "MoonBoard 2016": 1,
  "MoonBoard Masters 2017": 15,
  "MoonBoard Masters 2019": 17,
  "MoonBoard 2020": 19,
  "MoonBoard 2024": 21,
};

/** The MoonBoard is a fixed 40-degree wall. */
const MOON_ANGLE = 40;
const PAGE_SIZE = 40;

/** Form body for `POST /Logbook/GetLogbook` filtered to one setup. */
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

/** Pull a named `<input>`'s value from login-page HTML, regardless of attribute order. */
export function extractInputValue(html: string, name: string): string | undefined {
  const re1 = new RegExp(`name=["']${name}["'][^>]*?value=["']([^"']+)["']`, "i");
  const re2 = new RegExp(`value=["']([^"']+)["'][^>]*?name=["']${name}["']`, "i");
  return html.match(re1)?.[1] ?? html.match(re2)?.[1];
}

/** Login form body for `POST /Account/login`. */
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
  Project: null, // not a send — excluded
};

/** Map MoonBoard's NumberOfTries label to an attempt count (null = project / not sent). */
export function parseMoonTries(label: string | undefined): number | null {
  if (!label) return 1;
  return label in ATTEMPTS_TO_TRIES ? ATTEMPTS_TO_TRIES[label]! : 1;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse MoonBoard's "15 Nov 2023" date into an ISO date "2023-11-15". */
export function parseMoonDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return undefined;
  const mm = MONTHS[m[2]!.toLowerCase()];
  if (!mm) return undefined;
  return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
}

/** A raw MoonBoard logbook entry (subset we consume). */
export interface MoonEntry {
  Id?: number;
  DateClimbedAsString?: string;
  NumberOfTries?: string;
  Comment?: string;
  Problem?: {
    Name?: string;
    Grade?: string; // displayed/consensus, Font e.g. "7A+"
    UserGrade?: string; // user-logged
    IsBenchmark?: boolean;
  };
}

/** Map one MoonBoard logbook entry to a normalized {@link Ascent}. Null for projects / undated. */
export function moonEntryToAscent(entry: MoonEntry): Ascent | null {
  const date = parseMoonDate(entry.DateClimbedAsString);
  if (!date) return null;
  const tries = parseMoonTries(entry.NumberOfTries);
  if (tries === null) return null; // project, not an ascent
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
  };
}

/** Map a batch of raw entries, dropping projects/undated rows. */
export function moonEntriesToAscents(entries: MoonEntry[]): Ascent[] {
  const out: Ascent[] = [];
  for (const e of entries) {
    const a = moonEntryToAscent(e);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Live connect + sync for MoonBoard. Pass credentials or an existing `{ token }` (a serialized
 * cookie jar) to re-sync. Throws {@link BoardError} on any known failure.
 */
export async function connectMoonboard(
  auth: BoardAuth,
  opts: ConnectOptions = {},
): Promise<ConnectResult> {
  const doFetch = opts.fetch ?? fetch;
  const ua = opts.userAgent ?? DEFAULT_UA;

  const jar: CookieJar =
    "token" in auth ? jarFromHeader(auth.token) : await moonLogin(auth.username, auth.password, doFetch, ua);

  const entries = await fetchAllEntries(jar, doFetch, ua);
  if (entries === null) throw new BoardError("session-expired", "session expired", "moonboard");
  return { board: "moonboard", token: jarToHeader(jar), ascents: moonEntriesToAscents(entries) };
}

async function moonLogin(
  username: string | undefined,
  password: string | undefined,
  doFetch: typeof fetch,
  ua: string,
): Promise<CookieJar> {
  if (!username || !password) {
    throw new BoardError("missing-credentials", "username and password required", "moonboard");
  }
  const jar: CookieJar = new Map();

  // 1. CSRF token + initial cookies.
  let page: Response;
  try {
    page = await doFetch(`${MOON_HOST}/account/login`, { headers: { "User-Agent": ua } });
  } catch {
    throw new BoardError("unreachable", "could not reach MoonBoard", "moonboard");
  }
  if (!page.ok) throw new BoardError("unexpected-response", "could not load login page", "moonboard");
  addSetCookies(jar, page);
  const html = await page.text();
  const token = extractInputValue(html, "__RequestVerificationToken");
  const formKey = extractInputValue(html, "form_key") ?? "";
  if (!token) throw new BoardError("unexpected-response", "login form changed (no CSRF token)", "moonboard");

  // 2. Submit credentials.
  let res: Response;
  try {
    res = await doFetch(`${MOON_HOST}/Account/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${MOON_HOST}/account/login`,
        "User-Agent": ua,
        Cookie: jarToHeader(jar),
      },
      body: loginFormBody(username, password, token, formKey),
    });
  } catch {
    throw new BoardError("unreachable", "could not reach MoonBoard", "moonboard");
  }
  addSetCookies(jar, res);
  // A successful login redirects (3xx) and sets an auth cookie; a 200 usually re-rendered the form.
  const redirected = res.status >= 300 && res.status < 400;
  const hasAuth = [...jar.keys()].some((k) => /auth|aspnet|moon/i.test(k));
  if (!redirected && !hasAuth) {
    throw new BoardError("bad-credentials", "Incorrect MoonBoard email or password.", "moonboard");
  }
  return jar;
}

/** Sweep every board setup, paginating each. Returns null if the session is no longer valid. */
async function fetchAllEntries(
  jar: CookieJar,
  doFetch: typeof fetch,
  ua: string,
): Promise<MoonEntry[] | null> {
  const all: MoonEntry[] = [];
  let sawValidResponse = false;

  for (const setupId of Object.values(MOON_BOARD_IDS)) {
    for (let page = 1; page <= 25; page++) {
      const res = await doFetch(`${MOON_HOST}/Logbook/GetLogbook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": ua,
          Cookie: jarToHeader(jar),
        },
        body: logbookBody(setupId, page, PAGE_SIZE),
      });
      if (res.status === 401 || res.status === 403) return sawValidResponse ? all : null;
      if (!res.ok) break; // soft error on this setup
      let json: { Data?: MoonEntry[]; Total?: number };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        return sawValidResponse ? all : null; // HTML (login page) => session invalid
      }
      sawValidResponse = true;
      const rows = json.Data ?? [];
      all.push(...(await expandRows(jar, rows, doFetch, ua)));
      const total = json.Total ?? rows.length;
      if (rows.length === 0 || total <= PAGE_SIZE * page) break;
    }
  }
  return all;
}

/**
 * A GetLogbook row is either an ascent (has `Problem`) or a session group (has `Id` only); for the
 * latter we pull its entries from GetLogbookEntries/{id}. Handles both response shapes.
 */
async function expandRows(
  jar: CookieJar,
  rows: MoonEntry[],
  doFetch: typeof fetch,
  ua: string,
): Promise<MoonEntry[]> {
  const out: MoonEntry[] = [];
  for (const row of rows) {
    if (row.Problem) {
      out.push(row);
    } else if (row.Id != null) {
      const res = await doFetch(`${MOON_HOST}/Logbook/GetLogbookEntries/${row.Id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": ua,
          Cookie: jarToHeader(jar),
        },
        body: logbookBody(0, 1, PAGE_SIZE),
      });
      if (!res.ok) continue;
      try {
        const json = (await res.json()) as { Data?: MoonEntry[] };
        out.push(...(json.Data ?? []));
      } catch {
        /* ignore malformed page */
      }
    }
  }
  return out;
}
