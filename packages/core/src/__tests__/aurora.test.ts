import { describe, expect, it } from "vitest";
import {
  auroraSyncToAscents,
  buildDifficultyMap,
  connectAurora,
  loginBody,
  syncBody,
} from "../aurora.js";

describe("aurora pure mapping", () => {
  it("builds request bodies", () => {
    expect(loginBody("u", "p")).toMatchObject({ username: "u", password: "p", ua: "app" });
    const body = syncBody();
    expect(body).toContain("ascents=");
    expect(body).toContain("difficulty_grades=");
  });

  it("maps difficulty rows to a grade label map", () => {
    const map = buildDifficultyMap([
      { difficulty: 15, boulder_name: "6C+/V5" },
      { difficulty: 20.4, boulder_name: "7C+/V10" },
    ]);
    expect(map.get(15)).toBe("6C+/V5");
    expect(map.get(20)).toBe("7C+/V10"); // rounded
  });

  it("maps a sync response to normalized ascents with parsed vGrade", () => {
    const ascents = auroraSyncToAscents("kilter", {
      ascents: [
        { climbed_at: "2026-05-01 19:30:00", difficulty: 15, angle: 40, bid_count: 2 },
        { climbed_at: "2026-05-02 10:00:00", difficulty: 20, is_listed: false }, // dropped
        { difficulty: 15 }, // no date -> dropped
      ],
      difficulty_grades: [
        { difficulty: 15, boulder_name: "6C+/V5" },
        { difficulty: 20, boulder_name: "7C+/V10" },
      ],
    });
    expect(ascents).toHaveLength(1);
    const a = ascents[0]!;
    expect(a.board).toBe("kilter");
    expect(a.grade).toBe("6C+/V5");
    expect(a.vGrade).toBe(5);
    expect(a.tries).toBe(3); // bid_count + 1
    expect(a.angle).toBe(40);
    expect(a.date).toBe("2026-05-01T19:30:00Z");
  });

  it("falls back to approximate V when the grade table is absent", () => {
    const ascents = auroraSyncToAscents("tension", {
      ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 16 }],
    });
    expect(ascents[0]!.grade).toBe("V6"); // 16 - 10
  });
});

describe("connectAurora (mocked fetch)", () => {
  const okJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("exchanges credentials for a token then syncs", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/sessions")) return okJson({ session: "TOK123" });
      return okJson({
        ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 15 }],
        difficulty_grades: [{ difficulty: 15, boulder_name: "6C+/V5" }],
      });
    }) as unknown as typeof fetch;

    const res = await connectAurora("kilter", { username: "u", password: "p" }, { fetch: fakeFetch });
    expect(res.token).toBe("TOK123");
    expect(res.ascents).toHaveLength(1);
    expect(calls[0]).toContain("/sessions");
    expect(calls[1]).toContain("/sync");
  });

  it("throws bad-credentials on a 401 login", async () => {
    const fakeFetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(
      connectAurora("kilter", { username: "u", password: "bad" }, { fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: "bad-credentials" });
  });

  it("signals session-expired on a 401 sync with an existing token", async () => {
    const fakeFetch = (async (url: string) =>
      String(url).endsWith("/sync")
        ? new Response("", { status: 401 })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(
      connectAurora("tension", { token: "OLD" }, { fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: "session-expired" });
  });
});
