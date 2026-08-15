import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBoardServer, type BoardServerOptions } from "../server.js";

// Spin up createBoardServer on an ephemeral port for the duration of one test.
function start(opts: BoardServerOptions): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createBoardServer(opts);
    server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

// A minimal client that resolves on the response OR a socket error (needed for the oversize-body
// teardown case). `body` is streamed as-is; pass a huge string to overflow the readBody cap.
function hit(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status?: number; headers?: Record<string, string>; body?: string; error?: Error }> {
  return new Promise((resolve) => {
    const req = request(
      { port, host: "127.0.0.1", method, path, headers: opts.headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers as Record<string, string>,
            body: data,
          }),
        );
      },
    );
    req.on("error", (error) => resolve({ error }));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function boot(opts: BoardServerOptions) {
  const { server, port } = await start(opts);
  servers.push(server);
  return port;
}

describe("createBoardServer", () => {
  it("serves /health without auth or rate limiting", async () => {
    const port = await boot({ auth: () => false, rateLimit: { windowMs: 1000, max: 0 } });
    const res = await hit(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!).ok).toBe(true);
  });

  it("tears down the connection when the body exceeds the 1MB cap", async () => {
    const port = await boot({});
    const res = await hit(port, "POST", "/tension", { body: "x".repeat(1_100_000) });
    // The socket is destroyed on overflow, so the client observes a connection error (reset) and
    // never a completed response — asserting the teardown specifically, not merely "not a 200".
    expect(res.error).toBeDefined();
    expect(res.status).toBeUndefined();
  });

  it("rejects with 401 when the auth predicate returns false", async () => {
    const port = await boot({ auth: (req) => req.headers["x-api-key"] === "secret" });
    const res = await hit(port, "POST", "/tension", { body: "{}" });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body!).error).toBe("unauthorized");
  });

  it("treats a throwing auth predicate as unauthorized, not a 500", async () => {
    const port = await boot({
      auth: () => {
        throw new Error("boom");
      },
    });
    const res = await hit(port, "POST", "/tension", { body: "{}" });
    expect(res.status).toBe(401);
  });

  it("lets an authorized request through the auth gate", async () => {
    const port = await boot({ auth: (req) => req.headers["x-api-key"] === "secret" });
    // Passes auth, then fails JSON parse -> 400 proves we got past the gate.
    const res = await hit(port, "POST", "/tension", {
      headers: { "x-api-key": "secret" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid JSON");
  });

  it("rate-limits with 429 and a Retry-After header once max is exceeded", async () => {
    const port = await boot({ rateLimit: { windowMs: 60_000, max: 1 } });
    const first = await hit(port, "POST", "/tension", { body: "not json" });
    expect(first.status).toBe(400); // allowed (past the limiter), just bad JSON
    const second = await hit(port, "POST", "/tension", { body: "not json" });
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body!).error).toBe("rate limited");
    expect(Number(second.headers!["retry-after"])).toBeGreaterThan(0);
  });

  it("denies the very first request when max is 0", async () => {
    // Regression: the limiter must count-then-compare, so max:0 blocks even the first request in
    // a window rather than admitting it (a `max` of 0 means "no requests allowed").
    const port = await boot({ rateLimit: { windowMs: 60_000, max: 0 } });
    const res = await hit(port, "POST", "/tension", { body: "not json" });
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body!).error).toBe("rate limited");
  });

  it("exempts /health from the rate limit", async () => {
    const port = await boot({ rateLimit: { windowMs: 60_000, max: 1 } });
    await hit(port, "GET", "/health");
    await hit(port, "GET", "/health");
    const res = await hit(port, "GET", "/health");
    expect(res.status).toBe(200);
  });

  describe("with a stubbed Aurora backend", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    const stubAurora = () => {
      globalThis.fetch = (async (url: string) =>
        String(url).endsWith("/sessions")
          ? new Response(JSON.stringify({ session: "TOK" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(
              JSON.stringify({
                ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 15 }],
                difficulty_grades: [{ difficulty: 15, boulder_name: "6C+/V5" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )) as unknown as typeof fetch;
    };

    it("sets Cache-Control: no-store on the token-bearing success response", async () => {
      stubAurora();
      const port = await boot({});
      const res = await hit(port, "POST", "/tension", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers!["cache-control"]).toBe("no-store");
      expect(JSON.parse(res.body!).token).toBe("TOK");
    });

    it("strips raw by default and keeps it with includeRaw", async () => {
      stubAurora();
      const stripped = await hit(await boot({}), "POST", "/tension", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      });
      expect("raw" in JSON.parse(stripped.body!).ascents[0]).toBe(false);

      stubAurora();
      const withRaw = await hit(await boot({ includeRaw: true }), "POST", "/tension", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      });
      expect(JSON.parse(withRaw.body!).ascents[0].raw).toBeDefined();
    });
  });
});
