import type { Ascent, BoardAuth, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { DIFFICULTY_GRADES, gradeForDifficulty, type DifficultyGrade } from "./difficulty.js";
import { addSetCookies, jarToHeader, type CookieJar } from "./http.js";

// The Kilter app's backend (kiltergrips.com) since Kilter left Aurora in 2025. See
// docs/kilter-new-api.md. Auth is Keycloak (OIDC + PKCE); the logbook comes from the portal REST API
// (GET /api/logs), enriched by the server with climb names and grades.

export const KILTER_HOSTS = {
  idp: "https://idp.kiltergrips.com",
  api: "https://portal.kiltergrips.com",
  sync: "https://sync1.kiltergrips.com",
} as const;

const REALM = "kilter";
const CLIENT_ID = "kilter";
const REDIRECT_URI = "com.kiltergrips:/oauthredirect";
const APP_UA = "Dart/3.10 (dart:io)";

export interface KilterTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(len = 32): string {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return base64url(b);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function form(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Runs the Authorization Code + PKCE flow. The password is used once and never returned or stored.
export async function kilterLogin(
  username: string,
  password: string,
  opts: ConnectOptions = {},
): Promise<KilterTokens> {
  const doFetch = opts.fetch ?? fetch;
  if (!username || !password) {
    throw new BoardError("missing-credentials", "username and password required", "kilter");
  }

  const verifier = randomToken(48);
  const authUrl =
    `${KILTER_HOSTS.idp}/realms/${REALM}/protocol/openid-connect/auth?` +
    form({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid offline_access",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: randomToken(16),
      nonce: randomToken(16),
    });

  let page: Response;
  try {
    page = await doFetch(authUrl, { headers: { "User-Agent": APP_UA }, redirect: "manual" });
  } catch {
    throw new BoardError("unreachable", "could not reach Kilter login", "kilter");
  }
  const jar: CookieJar = new Map();
  addSetCookies(jar, page);
  const html = await page.text();
  const action = html.match(/action=["']([^"']+login-actions\/authenticate[^"']*)["']/i)?.[1];
  if (!action) {
    throw new BoardError("unexpected-response", "Kilter login form changed (no action URL)", "kilter");
  }

  let res: Response;
  try {
    res = await doFetch(decodeEntities(action), {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": APP_UA,
        Cookie: jarToHeader(jar),
      },
      body: form({ username, password }),
    });
  } catch {
    throw new BoardError("unreachable", "could not reach Kilter login", "kilter");
  }

  // Success is a 302 back to the app's redirect URI; a re-rendered form (200) means bad credentials.
  const location = res.headers.get("location") ?? "";
  if (res.status < 300 || res.status >= 400 || !location.startsWith(REDIRECT_URI)) {
    throw new BoardError("bad-credentials", "Incorrect Kilter email or password.", "kilter");
  }
  const code = new URL(location.replace(REDIRECT_URI, "https://x")).searchParams.get("code");
  if (!code) throw new BoardError("unexpected-response", "no authorization code returned", "kilter");

  return tokenRequest(doFetch, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
  });
}

// Trades a stored refresh token for a fresh access token, so re-syncs need no password.
export async function kilterRefresh(refreshToken: string, opts: ConnectOptions = {}): Promise<KilterTokens> {
  return tokenRequest(opts.fetch ?? fetch, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

async function tokenRequest(doFetch: typeof fetch, body: Record<string, string>): Promise<KilterTokens> {
  let res: Response;
  try {
    res = await doFetch(`${KILTER_HOSTS.idp}/realms/${REALM}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": APP_UA },
      body: form(body),
    });
  } catch {
    throw new BoardError("unreachable", "could not reach Kilter token endpoint", "kilter");
  }
  if (res.status === 400 || res.status === 401) {
    const refreshing = body.grant_type === "refresh_token";
    throw new BoardError(
      refreshing ? "session-expired" : "bad-credentials",
      refreshing ? "Kilter session expired" : "Kilter login rejected",
      "kilter",
    );
  }
  if (!res.ok) throw new BoardError("unexpected-response", `token request failed (${res.status})`, "kilter");
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new BoardError("unexpected-response", "token response missing tokens", "kilter");
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

// Kilter's currentDifficultyId indexes the shared Aurora difficulty table (see difficulty.ts).
export type KilterGrade = DifficultyGrade;
export const KILTER_DIFFICULTY_GRADES = DIFFICULTY_GRADES;

// Resolves a difficulty_grade_id to its grade on every scale, or undefined if unknown.
export const kilterGrade = gradeForDifficulty;

// One entry from GET /api/logs, the authenticated user's logbook. The server joins the climb name
// and its current consensus difficulty in, so no catalog lookup is needed. Extra fields are kept.
export interface KilterLog {
  logUuid: string;
  climbUuid: string;
  climbName: string;
  angle: number;
  attempts: number;
  flashed: boolean;
  topped: boolean;
  createdAt: string;
  currentDifficultyId?: number;
  /** The user's own grade suggestion for this climb, when they submitted one. */
  climbRating?: { difficultyGradeId?: number } & Record<string, unknown>;
  [key: string]: unknown;
}

// Fetches the authenticated user's logbook. The bearer token identifies the user; there is no id in
// the path (the /api/logs/{id} form is for viewing another user's public logs).
export async function kilterFetchLogbook(accessToken: string, opts: ConnectOptions = {}): Promise<KilterLog[]> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${KILTER_HOSTS.api}/api/logs`, {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": APP_UA, Accept: "application/json" },
    });
  } catch {
    throw new BoardError("unreachable", "could not reach Kilter logbook", "kilter");
  }
  if (res.status === 401) throw new BoardError("session-expired", "Kilter session expired", "kilter");
  if (!res.ok) throw new BoardError("unexpected-response", `logbook request failed (${res.status})`, "kilter");
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? (body as KilterLog[]) : [];
}

// Maps one logbook entry to a normalized ascent. The consensus grade fills {@link Ascent.grade};
// the user's own suggestion, when present and different, fills {@link Ascent.userGrade}.
export function kilterLogToAscent(log: KilterLog): Ascent {
  const consensus = kilterGrade(log.currentDifficultyId);
  const ownId = log.climbRating?.difficultyGradeId;
  const own = ownId != null ? KILTER_DIFFICULTY_GRADES[ownId] : undefined;
  return {
    board: "kilter",
    climbName: log.climbName ?? "",
    date: log.createdAt,
    grade: consensus?.label,
    userGrade: own && own.label !== consensus?.label ? own.label : undefined,
    vGrade: consensus?.vGrade,
    tries: typeof log.attempts === "number" ? log.attempts : log.flashed ? 1 : undefined,
    angle: typeof log.angle === "number" ? log.angle : undefined,
    raw: log,
  };
}

// Pass credentials or a stored refresh token. Returns the (rotated) refresh token to store and the
// normalized logbook. Only topped ascents are included; raw attempt logs are skipped.
export async function connectKilter(auth: BoardAuth, opts: ConnectOptions = {}): Promise<ConnectResult> {
  const tokens =
    "token" in auth ? await kilterRefresh(auth.token, opts) : await kilterLogin(auth.username, auth.password, opts);
  const logs = await kilterFetchLogbook(tokens.accessToken, opts);
  const ascents = logs.filter((l) => l.topped !== false).map(kilterLogToAscent);
  return { board: "kilter", token: tokens.refreshToken, ascents };
}

// --- Advanced: raw board data over PowerSync ---------------------------------------------------
// The logbook above needs only the REST API. The app also streams the full board dataset (holds,
// walls, gyms, difficulty grades, hold geometry) over PowerSync; kilterPowersyncPull exposes that
// raw, for callers that want to render climbs or inspect the catalog. It is not needed for ascents.

interface SyncData {
  bucket: string;
  data: { op_id: string; op: string; object_type?: string; object_id?: string; data?: string | object }[];
}

// PowerSync rows grouped by table name (object_type), keyed by object id.
export type KilterTables = Record<string, Record<string, Record<string, unknown>>>;

// Requests a full sync (after "0") and collects rows until the initial checkpoint completes. The
// connection would otherwise stay open for live updates, so we stop once the first checkpoint lands.
export async function kilterPowersyncPull(accessToken: string, opts: ConnectOptions = {}): Promise<KilterTables> {
  const doFetch = opts.fetch ?? fetch;
  const body = {
    buckets: [{ name: "global[]", after: "0" }],
    include_checksum: true,
    raw_data: true,
    binary_data: false,
    client_id: randomUuid(),
    parameters: {},
    streams: { include_defaults: true, subscriptions: [] },
    app_metadata: {},
  };

  let res: Response;
  try {
    res = await doFetch(`${KILTER_HOSTS.sync}/sync/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "powersync-dart-core/1.7.0",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BoardError("unreachable", "could not reach Kilter sync", "kilter");
  }
  if (res.status === 401) throw new BoardError("session-expired", "Kilter sync unauthorized", "kilter");
  if (!res.ok || !res.body) {
    throw new BoardError("unexpected-response", `sync failed (${res.status})`, "kilter");
  }

  const tables: KilterTables = {};
  for await (const line of ndjsonLines(res.body)) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (msg.data) applyBucketData(tables, msg.data as SyncData);
    if ("checkpoint_complete" in msg) break;
  }
  return tables;
}

function applyBucketData(tables: KilterTables, sd: SyncData): void {
  for (const op of sd.data ?? []) {
    const type = op.object_type;
    const id = op.object_id;
    if (!type || !id) continue;
    const table = (tables[type] ??= {});
    if (op.op === "REMOVE") {
      delete table[id];
      continue;
    }
    // With raw_data set, a row's payload arrives as a JSON string.
    if (typeof op.data === "string") {
      try {
        table[id] = JSON.parse(op.data) as Record<string, unknown>;
      } catch {
        table[id] = { _raw: op.data };
      }
    } else if (op.data && typeof op.data === "object") {
      table[id] = op.data as Record<string, unknown>;
    } else {
      table[id] = {};
    }
  }
}

async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  // @ts-expect-error web ReadableStream is async-iterable on Node 18+ and in browsers
  for await (const chunk of stream) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}
