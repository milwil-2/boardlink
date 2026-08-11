import { describe, expect, it } from "vitest";
import {
  aggregateDifficultyGradeId,
  buildKilterGradeMap,
  connectKilter,
  kilterLogin,
  kilterPowersyncPull,
  kilterTablesToAscents,
} from "../kilter.js";

const LOGIN_HTML = `<html><body><form method="post"
  action="https://idp.kiltergrips.com/realms/kilter/login-actions/authenticate?session_code=sc&amp;execution=ex&amp;client_id=kilter&amp;tab_id=tab">
  <input name="username"><input name="password"></form></body></html>`;

// A realistic PowerSync stream: difficulty_grades + logs, but NO climbs table (matches reality —
// the climb catalog is fetched via REST, not synced).
const NDJSON = [
  `{"checkpoint":{"last_op_id":"10","buckets":[]}}`,
  `{"data":{"bucket":"global[]","data":[{"op_id":"1","op":"PUT","object_type":"difficulty_grades","object_id":"16","data":"{\\"difficulty_grade_id\\":16,\\"boulder_difficulty\\":\\"6C+/V6\\",\\"v_scale\\":\\"V6\\"}"}]}}`,
  `{"data":{"bucket":"user[]","data":[{"op_id":"3","op":"PUT","object_type":"logs","object_id":"L1","data":"{\\"climb_uuid\\":\\"ABC\\",\\"angle\\":40,\\"attempts\\":2,\\"topped\\":1,\\"created_at\\":\\"2026-05-01 10:00:00Z\\"}"}]}}`,
  `{"checkpoint_complete":{"last_op_id":"10"}}`,
].join("\n");

const RATINGS = JSON.stringify([
  { username: "ANONYMOUS", angle: 40, difficultyGradeId: 16 },
  { username: "ANONYMOUS", angle: 40, difficultyGradeId: 16 },
]);

/** A fake fetch covering the full new-Kilter flow incl. the climb-rating grade lookup. */
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
    if (u.endsWith("/sync/stream") && method === "POST") {
      return new Response(NDJSON, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (u.includes("/api/climb-rating/")) {
      return new Response(RATINGS, { status: 200, headers: { "content-type": "application/json" } });
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

describe("kilter grade helpers", () => {
  it("builds the difficulty_grade_id -> grade map", () => {
    const map = buildKilterGradeMap({
      difficulty_grades: { "16": { difficulty_grade_id: 16, boulder_difficulty: "6C+/V6", v_scale: "V6" } },
    });
    expect(map.get(16)).toEqual({ grade: "6C+/V6", vGrade: 6 });
  });

  it("aggregates community difficultyGradeIds to a rounded mean", () => {
    expect(aggregateDifficultyGradeId([{ difficultyGradeId: 16 }, { difficultyGradeId: 18 }])).toBe(17);
    expect(aggregateDifficultyGradeId([])).toBeUndefined();
  });
});

describe("kilter PowerSync pull + normalization (mocked)", () => {
  it("parses the ndjson stream into tables (no climbs table, as in reality)", async () => {
    const tables = await kilterPowersyncPull("ACCESS", { fetch: fakeKilterFetch() });
    expect(Object.keys(tables).sort()).toEqual(["difficulty_grades", "logs"]);
    expect(tables.logs!.L1!.climb_uuid).toBe("ABC");
  });

  it("offline join uses a climbs table when present, normalizes the date, filters non-sends", () => {
    const ascents = kilterTablesToAscents({
      logs: {
        L1: { climb_uuid: "ABC", angle: 40, attempts: 2, topped: 1, created_at: "2026-05-01 10:00:00Z" },
        L2: { climb_uuid: "ABC", angle: 40, attempts: 5, topped: 0, created_at: "2026-05-02 10:00:00Z" }, // not a send
      },
      climbs: { ABC: { name: "Test Climb", officialKilterDifficulty: 16 } },
      difficulty_grades: { "16": { difficulty_grade_id: 16, boulder_difficulty: "6C+/V6", v_scale: "V6" } },
    });
    expect(ascents).toHaveLength(1); // L2 dropped (topped 0)
    const a = ascents[0]!;
    expect(a.climbName).toBe("Test Climb");
    expect(a.grade).toBe("6C+/V6");
    expect(a.vGrade).toBe(6);
    expect(a.tries).toBe(2);
    expect(a.angle).toBe(40);
    expect(a.date).toBe("2026-05-01T10:00:00Z");
  });

  it("returns [] (not a crash) when there is no logs table", () => {
    expect(kilterTablesToAscents({ climbs: {} })).toEqual([]);
  });
});

describe("connectKilter end-to-end (mocked) — grade via climb-rating enrichment", () => {
  it("logs in, pulls, enriches grades, returns refresh token + ascents", async () => {
    const res = await connectKilter({ username: "u", password: "p" }, { fetch: fakeKilterFetch() });
    expect(res.board).toBe("kilter");
    expect(res.token).toBe("REFRESH"); // store the refresh token, never the password
    expect(res.ascents).toHaveLength(1);
    const a = res.ascents[0]!;
    expect(a.grade).toBe("6C+/V6"); // resolved from /api/climb-rating -> difficulty_grades
    expect(a.vGrade).toBe(6);
    expect(a.tries).toBe(2);
    expect(a.date).toBe("2026-05-01T10:00:00Z");
  });
});
