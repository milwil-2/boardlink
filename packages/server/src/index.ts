import { connectBoard, BoardError, type BoardSystem, type ConnectOptions } from "@boardlink/core";

/**
 * Framework-agnostic core of the server. Give it a board name and a parsed JSON body; get back a
 * status code and JSON payload. Use this directly inside Next.js route handlers, Express, Hono, or
 * the bundled Node server below — it does no I/O of its own beyond calling the connector.
 *
 * Request body: { username, password } | { token }
 * Success:      200 { board, token, ascents }
 * Failure:      4xx/5xx { error, code, reauth? }
 */
export interface BoardRequestBody {
  username?: string;
  password?: string;
  token?: string;
}

export interface BoardResponse {
  status: number;
  body: Record<string, unknown>;
}

const VALID_BOARDS: BoardSystem[] = ["kilter", "tension", "moonboard"];

const STATUS_FOR: Record<string, number> = {
  "missing-credentials": 400,
  "bad-credentials": 401,
  "session-expired": 401,
  "unreachable": 502,
  "unexpected-response": 502,
};

export async function handleBoardRequest(
  board: string,
  body: BoardRequestBody,
  opts?: ConnectOptions,
): Promise<BoardResponse> {
  if (!VALID_BOARDS.includes(board as BoardSystem)) {
    return { status: 400, body: { error: `unknown board '${board}'`, code: "unexpected-response" } };
  }
  const auth = body.token ? { token: body.token } : { username: body.username ?? "", password: body.password ?? "" };
  try {
    const result = await connectBoard(board as BoardSystem, auth, opts);
    return { status: 200, body: { ...result } };
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

export { createBoardServer } from "./server.js";
