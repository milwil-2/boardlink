import { describe, expect, it } from "vitest";
import {
  connectKilter,
  kilterFetchLogbook,
  kilterGrade,
  kilterLogToAscent,
  kilterLogin,
  kilterPowersyncPull,
  type KilterLog,
} from "../kilter.js";

const LOGIN_HTML = `<html><body><form method="post"
  action="https://idp.kiltergrips.com/realms/kilter/login-actions/authenticate?session_code=sc&amp;execution=ex&amp;client_id=kilter&amp;tab_id=tab">
  <input name="username"><input name="password"></form></body></html>`;

// GET /api/logs returns the logbook already joined with climb name + current difficulty. Two sends
// (one with the user's own grade suggestion) plus one non-topped attempt that must be filtered out.
const LOGBOOK: KilterLog[] = [
  {
    logUuid: "L1", climbUuid: "ABC", climbName: "floatin", angle: 45,
    attempts: 1, flashed: true, topped: true,
    createdAt: "2026-08-12T20:14:24.373606Z", currentDifficultyId: 26,
  },
  {
    logUuid: "L2", climbUuid: "DEF", climbName: "Highgarden", angle: 45,
    attempts: 3, flashed: false, topped: true,
    createdAt: "2026-08-10T03:35:40.743324Z", currentDifficultyId: 26,
    climbRating: { difficultyGradeId: 25 },
  },
  {
    logUuid: "L3", climbUuid: "GHI", climbName: "project", angle: 50,
    attempts: 6, flashed: false, topped: false,
    createdAt: "2026-08-09T00:00:00Z", currentDifficultyId: 30,
  },
];

/** A fake fetch covering the new-Kilter flow: Keycloak login then GET /api/logs. */
function fakeKilterFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/protocol/openid-connect/auth")) {
      return new Response(LOGIN_HTML, { status: 200, headers: { "set-cookie": "AUTH_SESSION_ID=abc; path=/" } });
    }
    if (u.includes("login-actions/authenticate") && method === "POST") {
      return new Response("", { status: 302, headers: { location: "com.kiltergrips:/oauthredirect?code=CODE123&state=s" } });
    }
    if (u.endsWith("/token") && method === "POST") {
      return new Response(JSON.stringify({ access_token: "ACCESS", refresh_token: "REFRESH", expires_in: 14400 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/logs")) {
      return new Response(JSON.stringify(LOGBOOK), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("kilter auth (Keycloak OIDC+PKCE, mocked)", () => {
  it("logs in and returns access + refresh tokens", async () => {
    const tokens = await kilterLogin("u", "p", { fetch: fakeKilterFetch() });
    expect(tokens.accessToken).toBe("ACCESS");
    expect(tokens.refreshToken).toBe("REFRESH");
  });

  it("throws bad-credentials when the login form re-renders (200, no redirect)", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/openid-connect/auth")) return new Response(LOGIN_HTML, { status: 200 });
      if (u.includes("login-actions/authenticate")) return new Response(LOGIN_HTML, { status: 200 });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(kilterLogin("u", "bad", { fetch: f })).rejects.toMatchObject({ code: "bad-credentials" });
  });
});

describe("kilter grade resolution", () => {
  it("maps a difficulty_grade_id to every scale", () => {
    expect(kilterGrade(26)).toEqual({
      label: "7C/V9", font: "7C", vScale: "V9", vGrade: 9, french: "8b", yds: "5.13d",
    });
    expect(kilterGrade(21)).toMatchObject({ label: "6C+/V5", font: "6C+", french: "7b+", yds: "5.12c" });
  });

  it("returns undefined for an unknown or missing id", () => {
    expect(kilterGrade(999)).toBeUndefined();
    expect(kilterGrade(null)).toBeUndefined();
    expect(kilterGrade(undefined)).toBeUndefined();
  });
});

describe("kilterLogToAscent", () => {
  it("maps a flashed send, deriving the grade from currentDifficultyId", () => {
    const a = kilterLogToAscent(LOGBOOK[0]!);
    expect(a.climbName).toBe("floatin");
    expect(a.grade).toBe("7C/V9");
    expect(a.vGrade).toBe(9);
    expect(a.tries).toBe(1);
    expect(a.angle).toBe(45);
    expect(a.date).toBe("2026-08-12T20:14:24.373606Z");
    expect(a.userGrade).toBeUndefined(); // no personal suggestion
    expect(a.raw).toBe(LOGBOOK[0]); // source record passed through
  });

  it("sets userGrade only when the user's own suggestion differs from the consensus", () => {
    const a = kilterLogToAscent(LOGBOOK[1]!);
    expect(a.grade).toBe("7C/V9"); // currentDifficultyId 26
    expect(a.userGrade).toBe("7B+/V8"); // climbRating.difficultyGradeId 25
  });
});

describe("connectKilter end-to-end (mocked)", () => {
  it("logs in, pulls /api/logs, returns the refresh token and only topped ascents", async () => {
    const res = await connectKilter({ username: "u", password: "p" }, { fetch: fakeKilterFetch() });
    expect(res.board).toBe("kilter");
    expect(res.token).toBe("REFRESH"); // store the refresh token, never the password
    expect(res.ascents).toHaveLength(2); // L3 dropped (topped false)
    expect(res.ascents.map((a) => a.climbName)).toEqual(["floatin", "Highgarden"]);
    expect(res.ascents[0]!.grade).toBe("7C/V9");
  });

  it("surfaces an expired session as a typed error", async () => {
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "A", refresh_token: "R" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/api/logs")) return new Response("", { status: 401 });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(connectKilter({ token: "stored" }, { fetch: f })).rejects.toMatchObject({ code: "session-expired" });
  });
});

describe("kilterFetchLogbook", () => {
  it("returns [] for a non-array body rather than throwing", async () => {
    const f = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await kilterFetchLogbook("ACCESS", { fetch: f })).toEqual([]);
  });
});

describe("kilterPowersyncPull (advanced raw board data, mocked)", () => {
  it("parses the ndjson sync stream into tables keyed by object_type", async () => {
    const ndjson = [
      `{"checkpoint":{"last_op_id":"2","buckets":[]}}`,
      `{"data":{"bucket":"global[]","data":[{"op_id":"1","op":"PUT","object_type":"difficulty_grades","object_id":"26","data":"{\\"id\\":26,\\"boulder_difficulty\\":\\"7C/V9\\"}"}]}}`,
      `{"checkpoint_complete":{"last_op_id":"2"}}`,
    ].join("\n");
    const f = (async () => new Response(ndjson, { status: 200 })) as unknown as typeof fetch;
    const tables = await kilterPowersyncPull("ACCESS", { fetch: f });
    expect(Object.keys(tables)).toEqual(["difficulty_grades"]);
    expect(tables.difficulty_grades!["26"]!.boulder_difficulty).toBe("7C/V9");
  });
});
