import { describe, expect, it } from "vitest";
import { auroraSyncToAscents, connectAurora, loginBody, syncBody } from "../aurora.js";

describe("aurora pure mapping", () => {
  it("builds request bodies", () => {
    expect(loginBody("u", "p")).toMatchObject({ username: "u", password: "p", ua: "app" });
    expect(syncBody()).toContain("ascents=");
  });

  it("maps a sync response to normalized ascents, resolving grades from the bundled table", () => {
    const ascents = auroraSyncToAscents("tension", {
      ascents: [
        { climbed_at: "2026-05-01 19:30:00", difficulty: 23, angle: 40, bid_count: 2, climb_uuid: "abc" },
        { climbed_at: "2026-05-02 10:00:00", difficulty: 20, is_listed: false }, // dropped (unlisted)
        { difficulty: 23 }, // no date -> dropped
      ],
    });
    expect(ascents).toHaveLength(1);
    const a = ascents[0]!;
    expect(a.board).toBe("tension");
    expect(a.grade).toBe("7A+/V7"); // difficulty 23 -> 7A+/V7, not the old (23-10)=V13 guess
    expect(a.vGrade).toBe(7);
    expect(a.tries).toBe(3); // bid_count + 1
    expect(a.angle).toBe(40);
    expect(a.date).toBe("2026-05-01T19:30:00Z");
    expect(a.raw).toMatchObject({ climb_uuid: "abc" }); // source row passed through
  });

  it("uses attempt_id as the tries count when present (1 = flash)", () => {
    const [a] = auroraSyncToAscents("tension", {
      ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 20, attempt_id: 1, bid_count: 9 }],
    });
    expect(a!.tries).toBe(1);
  });
});

describe("connectAurora (mocked fetch)", () => {
  const okJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("exchanges credentials for a token then syncs", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/sessions")) return okJson({ session: { token: "TOK123", user_id: 1 } });
      return okJson({ ascents: [{ climbed_at: "2026-05-01 19:30:00", difficulty: 20 }] });
    }) as unknown as typeof fetch;

    const res = await connectAurora("tension", { username: "u", password: "p" }, { fetch: fakeFetch });
    expect(res.token).toBe("TOK123");
    expect(res.ascents).toHaveLength(1);
    expect(res.ascents[0]!.grade).toBe("6C/V5");
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
