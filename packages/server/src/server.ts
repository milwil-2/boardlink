import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleBoardRequest, type BoardRequestBody } from "./index.js";

/** Options for the bundled zero-dependency Node server. */
export interface BoardServerOptions {
  /** Add permissive CORS headers and handle OPTIONS preflight. */
  cors?: boolean;
  /**
   * Authentication predicate over the raw request (check an API key header, mTLS, allowlist, ...).
   * Runs BEFORE the body is read. Return false (or reject/throw) -> 401 { error: "unauthorized" }.
   * Omitted = no auth (dev-only; never expose an auth-less server publicly).
   */
  auth?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /**
   * Fixed-window rate limit keyed on req.socket.remoteAddress (deliberately NOT x-forwarded-for,
   * which is spoofable; embedders behind a proxy should rate-limit at the proxy or use
   * handleBoardRequest in their own framework). Exceeding max within windowMs -> 429
   * { error: "rate limited" } with a Retry-After header (seconds to window end). In-memory Map,
   * pruned lazily on access; no timers, keeps the zero-dep promise.
   */
  rateLimit?: { windowMs: number; max: number };
  /** Include each ascent's raw backend record in responses. Default false: server strips raw. */
  includeRaw?: boolean;
}

// A dependency-free Node server for standing the API up quickly: POST /:board and GET /health. For
// production, put auth/TLS/rate-limiting in front (or embed handleBoardRequest in your own framework).
export function createBoardServer(opts: BoardServerOptions = {}): Server {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return createServer((req, res) => void route(req, res, opts, hits));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BoardServerOptions,
  hits: Map<string, { windowStart: number; count: number }>,
): Promise<void> {
  const send = (status: number, body: unknown, extraHeaders?: Record<string, string>) => {
    // The socket may already be torn down (e.g. readBody destroyed it on overflow); don't write.
    if (res.writableEnded || res.destroyed) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cors) {
      headers["access-control-allow-origin"] = "*";
      headers["access-control-allow-headers"] = "content-type, authorization";
      headers["access-control-allow-methods"] = "POST, OPTIONS";
    }
    if (extraHeaders) Object.assign(headers, extraHeaders);
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  // Pipeline: OPTIONS preflight (cors) -> GET /health (exempt) -> rateLimit -> auth -> method/path
  // -> readBody -> handleBoardRequest.
  if (opts.cors && req.method === "OPTIONS") return send(204, {});

  const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") return send(200, { ok: true });

  // Rate limit (cheapest first), keyed on the socket address. Fixed window, lazily pruned.
  if (opts.rateLimit) {
    const retryAfter = checkRateLimit(hits, req.socket.remoteAddress ?? "unknown", opts.rateLimit);
    if (retryAfter !== null) {
      return send(429, { error: "rate limited" }, { "retry-after": String(retryAfter) });
    }
  }

  // Auth predicate over the raw request. A throw/reject is treated as unauthorized, not a 500.
  if (opts.auth) {
    let allowed = false;
    try {
      allowed = await opts.auth(req);
    } catch {
      allowed = false;
    }
    if (!allowed) return send(401, { error: "unauthorized" });
  }

  if (req.method !== "POST") return send(405, { error: "method not allowed" });

  const board = path.replace(/^\//, "");
  let body: BoardRequestBody;
  try {
    body = JSON.parse(await readBody(req)) as BoardRequestBody;
  } catch {
    return send(400, { error: "invalid JSON" });
  }

  const { status, body: out } = await handleBoardRequest(board, body, { includeRaw: opts.includeRaw });
  // The success payload carries a session token (a credential): forbid any shared/browser caching.
  send(status, out, status === 200 ? { "cache-control": "no-store" } : undefined);
}

/**
 * Fixed-window rate limiter. Returns null when the request is allowed, otherwise the number of
 * seconds until the current window ends (for Retry-After). In-memory, no timers: stale windows are
 * reset on access and other keys pruned lazily so the Map can't grow unbounded.
 */
function checkRateLimit(
  hits: Map<string, { windowStart: number; count: number }>,
  key: string,
  cfg: { windowMs: number; max: number },
): number | null {
  const now = Date.now();
  // Lazy prune: drop any windows that have fully elapsed so idle clients don't accumulate.
  for (const [k, v] of hits) {
    if (now - v.windowStart >= cfg.windowMs) hits.delete(k);
  }
  // Count this request first, then compare, so a `max` of 0 denies even the first request in a
  // window (start a fresh window at count 1 rather than admitting it unconditionally).
  const entry = hits.get(key);
  const current =
    !entry || now - entry.windowStart >= cfg.windowMs
      ? (hits.set(key, { windowStart: now, count: 1 }), hits.get(key)!)
      : ((entry.count += 1), entry);
  if (current.count > cfg.max) {
    return Math.max(1, Math.ceil((current.windowStart + cfg.windowMs - now) / 1000));
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c) => {
      if (settled) return;
      data += c;
      if (data.length > 1_000_000) {
        // Overflow: tear the socket down so it can't keep streaming past the cap, and reject once.
        settle(() => {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          req.destroy();
          reject(new Error("body too large"));
        });
      }
    });
    req.on("end", () => settle(() => resolve(data)));
    req.on("error", (e) => settle(() => reject(e)));
  });
}
