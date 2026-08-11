import { describe, expect, it } from "vitest";
import { handleBoardRequest } from "../index.js";

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("handleBoardRequest", () => {
  it("rejects an unknown board with 400", async () => {
    const res = await handleBoardRequest("verminboard", { username: "u", password: "p" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unexpected-response");
  });

  it("proxies a successful Aurora login+sync", async () => {
    const fakeFetch = (async (url: string) =>
      String(url).endsWith("/sessions")
        ? okJson({ session: "TOK" })
        : okJson({
            ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 15 }],
            difficulty_grades: [{ difficulty: 15, boulder_name: "6C+/V5" }],
          })) as unknown as typeof fetch;

    const res = await handleBoardRequest(
      "tension",
      { username: "u", password: "p" },
      { fetch: fakeFetch },
    );
    expect(res.status).toBe(200);
    expect(res.body.token).toBe("TOK");
    expect((res.body.ascents as unknown[]).length).toBe(1);
  });

  it("maps bad credentials to 401", async () => {
    const fakeFetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const res = await handleBoardRequest(
      "tension",
      { username: "u", password: "bad" },
      { fetch: fakeFetch },
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("bad-credentials");
  });

  it("flags reauth on an expired session token", async () => {
    const fakeFetch = (async (url: string) =>
      String(url).endsWith("/sync")
        ? new Response("", { status: 401 })
        : okJson({})) as unknown as typeof fetch;
    const res = await handleBoardRequest("tension", { token: "OLD" }, { fetch: fakeFetch });
    expect(res.status).toBe(401);
    expect(res.body.reauth).toBe(true);
  });
});
