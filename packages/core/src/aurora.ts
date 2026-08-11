import type { Ascent, BoardAuth, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { parseVGrade } from "./grades.js";

// Aurora-backed boards (Tension). No official API; the flow mirrors the app:
//   POST /sessions { username, password, ... } -> { session: <token> }
//   POST /sync     (Cookie: token=<token>)     -> { ascents, difficulty_grades }
// The pure helpers below are I/O-free; connectAurora does the two requests.

export type AuroraBoard = "kilter" | "tension";

export const AURORA_HOSTS: Record<AuroraBoard, string> = {
  kilter: "https://kilterboardapp.com",
  tension: "https://tensionboardapp2.com",
};

export const BASE_SYNC_DATE = "1970-01-01 00:00:00.000000";

export function loginBody(username: string, password: string) {
  return { username, password, tou: "accepted", pp: "accepted", ua: "app" };
}

export function syncBody(): string {
  return ["ascents", "bids", "difficulty_grades"]
    .map((t) => `${encodeURIComponent(t)}=${encodeURIComponent(BASE_SYNC_DATE)}`)
    .join("&");
}

export interface DifficultyGradeRow {
  difficulty: number;
  boulder_name?: string; // e.g. "6C+/V5"
}

export function buildDifficultyMap(rows: DifficultyGradeRow[] | undefined): Map<number, string> {
  const map = new Map<number, string>();
  for (const r of rows ?? []) {
    if (r.boulder_name) map.set(Math.round(r.difficulty), r.boulder_name);
  }
  return map;
}

export interface AuroraAscent {
  uuid?: string;
  climb_uuid?: string;
  angle?: number;
  is_mirror?: boolean;
  is_listed?: boolean;
  climbed_at?: string;
  difficulty?: number | null;
  quality?: number;
  bid_count?: number;
  comment?: string;
}

export function auroraAscentToAscent(
  raw: AuroraAscent,
  board: AuroraBoard,
  difficultyMap: Map<number, string>,
): Ascent | null {
  if (!raw.climbed_at) return null;
  const grade = gradeFor(raw.difficulty, difficultyMap);
  return {
    board,
    climbName: "", // names would require syncing the whole climbs table
    date: normalizeDate(raw.climbed_at),
    grade,
    userGrade: grade,
    vGrade: parseVGrade(grade),
    tries: (raw.bid_count ?? 0) + 1,
    angle: raw.angle,
    isBenchmark: false,
    isMirror: raw.is_mirror ?? false,
    isRepeat: false,
    comment: raw.comment?.trim() || undefined,
  };
}

function gradeFor(difficulty: number | null | undefined, map: Map<number, string>): string | undefined {
  if (difficulty == null) return undefined;
  const d = Math.round(difficulty);
  return map.get(d) ?? approxV(d);
}

// Fallback when the shared grade table is missing: Aurora difficulty tracks V + ~10.
function approxV(difficulty: number): string | undefined {
  const v = difficulty - 10;
  return v >= 0 ? `V${v}` : undefined;
}

function normalizeDate(s: string): string {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
}

export function auroraSyncToAscents(
  board: AuroraBoard,
  resp: { ascents?: AuroraAscent[]; difficulty_grades?: DifficultyGradeRow[] },
): Ascent[] {
  const map = buildDifficultyMap(resp.difficulty_grades);
  const out: Ascent[] = [];
  for (const raw of resp.ascents ?? []) {
    if (raw.is_listed === false) continue;
    const a = auroraAscentToAscent(raw, board, map);
    if (a) out.push(a);
  }
  return out;
}

export async function connectAurora(
  board: AuroraBoard,
  auth: BoardAuth,
  opts: ConnectOptions = {},
): Promise<ConnectResult> {
  const doFetch = opts.fetch ?? fetch;
  const host = AURORA_HOSTS[board];

  let token: string | undefined = "token" in auth ? auth.token : undefined;
  if (!token) {
    const { username, password } = auth as { username?: string; password?: string };
    if (!username || !password) {
      throw new BoardError("missing-credentials", "username and password required", board);
    }
    let res: Response;
    try {
      res = await doFetch(`${host}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(loginBody(username, password)),
      });
    } catch {
      throw new BoardError("unreachable", "could not reach the board service", board);
    }
    if (res.status === 401 || res.status === 422) {
      throw new BoardError("bad-credentials", "Incorrect board email or password.", board);
    }
    if (!res.ok) throw new BoardError("unexpected-response", `login failed (${res.status})`, board);
    const json = (await res.json().catch(() => ({}))) as {
      session?: string | { token?: string };
      token?: string;
      login?: { token?: string };
    };
    token =
      (typeof json.session === "string" ? json.session : json.session?.token) ??
      json.token ??
      json.login?.token;
    if (!token) throw new BoardError("unexpected-response", "no session token returned", board);
  }

  let res: Response;
  try {
    res = await doFetch(`${host}/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        Cookie: `token=${token}`,
      },
      body: syncBody(),
    });
  } catch {
    throw new BoardError("unreachable", "could not reach the board service", board);
  }
  if (res.status === 401) throw new BoardError("session-expired", "session expired", board);
  if (!res.ok) throw new BoardError("unexpected-response", `sync failed (${res.status})`, board);
  const json = (await res.json().catch(() => {
    throw new BoardError("unexpected-response", "sync did not return JSON", board);
  })) as Parameters<typeof auroraSyncToAscents>[1];
  return { board, token, ascents: auroraSyncToAscents(board, json) };
}
