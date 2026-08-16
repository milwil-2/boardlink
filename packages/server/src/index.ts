import { connectBoard, stripRaw, BoardError, type BoardSystem, type ConnectOptions } from "@boardlink/core";

// Framework-agnostic request handler: takes a board name and a parsed JSON body, returns a status
// and JSON payload. Drop it into Next.js, Express, Hono, or the bundled Node server. Request body is
// { username, password } or { token }; success is { board, token, ascents }, errors { error, code }.
export interface BoardRequestBody {
  username?: string;
  password?: string;
  token?: string;
}

export interface BoardResponse {
  status: number;
  body: Record<string, unknown>;
}

// MoonBoard is still a recognized board name so the handler can answer with an honest 410 `retired`
// (via connectBoard) rather than a misleading "unknown board" 400. Its API was retired; see
// https://github.com/milwil-2/boardlink/issues/1.
const VALID_BOARDS: BoardSystem[] = ["kilter", "tension", "moonboard"];

const STATUS_FOR: Record<string, number> = {
  "missing-credentials": 400,
  "bad-credentials": 401,
  "session-expired": 401,
  "unreachable": 502,
  "unexpected-response": 502,
  // The board's API is gone; 410 Gone is the honest status for a permanently removed connector.
  "retired": 410,
};

export async function handleBoardRequest(
  board: string,
  body: BoardRequestBody,
  opts?: ConnectOptions & { includeRaw?: boolean },
): Promise<BoardResponse> {
  if (!VALID_BOARDS.includes(board as BoardSystem)) {
    return { status: 400, body: { error: `unknown board '${board}'`, code: "unexpected-response" } };
  }
  const auth = body.token ? { token: body.token } : { username: body.username ?? "", password: body.password ?? "" };
  try {
    const result = await connectBoard(board as BoardSystem, auth, opts);
    // Strip each ascent's raw backend record by default: HTTP responses are presumed to reach
    // browsers/untrusted clients, so over-exposure of unaudited backend fields must be opt-in.
    // includeRaw: true restores the untouched passthrough.
    const ascents = opts?.includeRaw ? result.ascents : stripRaw(result.ascents);
    return { status: 200, body: { ...result, ascents } };
  } catch (e) {
    if (e instanceof BoardError) {
      return {
        status: STATUS_FOR[e.code] ?? 502,
        body: { error: e.message, code: e.code, reauth: e.code === "session-expired" },
      };
    }
    return { status: 500, body: { error: "internal error", code: "unexpected-response" } };
  }
}

export { createBoardServer, type BoardServerOptions } from "./server.js";
