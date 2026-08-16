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

  it("answers 410 for the retired MoonBoard connector", async () => {
    const res = await handleBoardRequest("moonboard", { username: "u", password: "p" });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("retired");
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

  const auroraFetch = (async (url: string) =>
    String(url).endsWith("/sessions")
      ? okJson({ session: "TOK" })
      : okJson({
          ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 15 }],
          difficulty_grades: [{ difficulty: 15, boulder_name: "6C+/V5" }],
        })) as unknown as typeof fetch;

  it("strips each ascent's raw backend record by default", async () => {
    const res = await handleBoardRequest(
      "tension",
      { username: "u", password: "p" },
      { fetch: auroraFetch },
    );
    expect(res.status).toBe(200);
    const ascents = res.body.ascents as Array<Record<string, unknown>>;
    expect(ascents.length).toBe(1);
    // Property absent, not undefined-valued.
    expect("raw" in ascents[0]!).toBe(false);
  });

  it("preserves raw when includeRaw is set", async () => {
    const res = await handleBoardRequest(
      "tension",
      { username: "u", password: "p" },
      { fetch: auroraFetch, includeRaw: true },
    );
    expect(res.status).toBe(200);
    const ascents = res.body.ascents as Array<Record<string, unknown>>;
    expect(ascents[0]!.raw).toBeDefined();
  });
});
