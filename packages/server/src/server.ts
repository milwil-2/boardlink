import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleBoardRequest, type BoardRequestBody } from "./index.js";

// A dependency-free Node server for standing the API up quickly: POST /:board and GET /health. For
// production, embed handleBoardRequest in your own framework instead.
export function createBoardServer(opts: { cors?: boolean } = {}): Server {
  return createServer((req, res) => void route(req, res, opts));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { cors?: boolean },
): Promise<void> {
  const send = (status: number, body: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cors) {
      headers["access-control-allow-origin"] = "*";
      headers["access-control-allow-headers"] = "content-type";
      headers["access-control-allow-methods"] = "POST, OPTIONS";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  if (opts.cors && req.method === "OPTIONS") return send(204, {});

  const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") return send(200, { ok: true });

  if (req.method !== "POST") return send(405, { error: "method not allowed" });

  const board = path.replace(/^\//, "");
  let body: BoardRequestBody;
  try {
    body = JSON.parse(await readBody(req)) as BoardRequestBody;
  } catch {
    return send(400, { error: "invalid JSON" });
  }

  const { status, body: out } = await handleBoardRequest(board, body);
  send(status, out);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
