import type { Ascent, BoardAuth, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { gradeForDifficulty } from "./difficulty.js";

// Aurora-backed boards (Tension). No official API; the flow mirrors the app:
//   POST /sessions { username, password, ... } -> { session: { token, user_id } }
//   POST /sync     (Cookie: token=<token>)     -> { ascents: [...] }
// The sync returns each ascent's integer `difficulty` but not the grade table, so grades are
// resolved from the bundled Aurora difficulty table (see difficulty.ts). The pure helpers below are
// I/O-free; connectAurora does the two requests.

export type AuroraBoard = "kilter" | "tension";

export const AURORA_HOSTS: Record<AuroraBoard, string> = {
  kilter: "https://kilterboardapp.com",
  tension: "https://tensionboardapp2.com",
};

// The `/sync` route is gated on a native-app User-Agent; without it the server 404s. The app sends
// this string verbatim (the %20 is a literal, from the URL-encoded "Kilter Board" app name).
const AURORA_UA = "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0";

export const BASE_SYNC_DATE = "1970-01-01 00:00:00.000000";

export function loginBody(username: string, password: string) {
  return { username, password, tou: "accepted", pp: "accepted", ua: "app" };
}

export function syncBody(): string {
  return `ascents=${encodeURIComponent(BASE_SYNC_DATE)}`;
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
  attempt_id?: number;
  comment?: string;
  [key: string]: unknown;
}

export function auroraAscentToAscent(raw: AuroraAscent, board: AuroraBoard): Ascent | null {
  if (!raw.climbed_at) return null;
  const g = gradeForDifficulty(raw.difficulty);
  return {
    board,
    climbName: "", // Aurora's sync omits names; resolving them needs the climbs table (see docs)
    date: normalizeDate(raw.climbed_at),
    grade: g?.label,
    userGrade: g?.label,
    vGrade: g?.vGrade,
    // attempt_id, when set, is the tries count (1 = flash); otherwise a send took bid_count fails + 1.
    tries: raw.attempt_id ?? (raw.bid_count ?? 0) + 1,
    angle: raw.angle,
    isBenchmark: false,
    isMirror: raw.is_mirror ?? false,
    isRepeat: false,
    comment: raw.comment?.trim() || undefined,
    raw,
  };
}

function normalizeDate(s: string): string {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
}

export function auroraSyncToAscents(board: AuroraBoard, resp: { ascents?: AuroraAscent[] }): Ascent[] {
  const out: Ascent[] = [];
  for (const raw of resp.ascents ?? []) {
    if (raw.is_listed === false) continue;
    const a = auroraAscentToAscent(raw, board);
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
  const ua = opts.userAgent ?? AURORA_UA;

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
        headers: { "content-type": "application/json", accept: "application/json", "User-Agent": ua },
        body: JSON.stringify(loginBody(username, password)),
      });
    } catch {
      throw new BoardError("unreachable", "could not reach the board service", board);
    }
    if (res.status === 401 || res.status === 422) {
      // Aurora authenticates by username, not email — a common cause of this rejection.
      throw new BoardError("bad-credentials", "Incorrect username or password.", board);
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
        "User-Agent": ua,
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
