import { describe, expect, it } from "vitest";
import {
  connectMoonboard,
  extractInputValue,
  logbookBody,
  moonEntriesToAscents,
  moonEntryToAscent,
  parseMoonDate,
  parseMoonTries,
} from "../moon.js";

describe("moonboard pure mapping", () => {
  it("extracts the CSRF token regardless of attribute order", () => {
    const a = `<input name="__RequestVerificationToken" type="hidden" value="ABC123" />`;
    const b = `<input value="KEY9" name="form_key">`;
    expect(extractInputValue(a, "__RequestVerificationToken")).toBe("ABC123");
    expect(extractInputValue(b, "form_key")).toBe("KEY9");
    expect(extractInputValue(a, "missing")).toBeUndefined();
  });

  it("filters the logbook body to a setup id", () => {
    const body = logbookBody(17, 2, 40);
    expect(body).toContain("page=2");
    expect(body).toContain("pageSize=40");
    expect(decodeURIComponent(body)).toContain("filter=setupId~eq~'17'");
  });

  it("parses dates and tries", () => {
    expect(parseMoonDate("15 Nov 2023")).toBe("2023-11-15");
    expect(parseMoonDate("3 Jan 2026")).toBe("2026-01-03");
    expect(parseMoonDate("garbage")).toBeUndefined();
    expect(parseMoonTries("Flashed")).toBe(1);
    expect(parseMoonTries("3rd try")).toBe(3);
    expect(parseMoonTries("more than 3 tries")).toBe(4);
    expect(parseMoonTries("Project")).toBeNull();
  });

  it("maps an entry to normalized and skips projects", () => {
    const sent = moonEntryToAscent({
      DateClimbedAsString: "15 Nov 2023",
      NumberOfTries: "2nd try",
      Comment: " nice ",
      Problem: { Name: "Test", Grade: "7A+", UserGrade: "7A", IsBenchmark: true },
    });
    expect(sent).not.toBeNull();
    expect(sent!.board).toBe("moonboard");
    expect(sent!.angle).toBe(40);
    expect(sent!.grade).toBe("7A+");
    expect(sent!.vGrade).toBe(7); // "7A+" -> V7
    expect(sent!.tries).toBe(2);
    expect(sent!.isBenchmark).toBe(true);
    expect(sent!.comment).toBe("nice");

    const project = moonEntryToAscent({
      DateClimbedAsString: "16 Nov 2023",
      NumberOfTries: "Project",
      Problem: { Grade: "8A" },
    });
    expect(project).toBeNull();
  });

  it("batch-maps, dropping projects/undated", () => {
    const ascents = moonEntriesToAscents([
      { DateClimbedAsString: "15 Nov 2023", NumberOfTries: "Flashed", Problem: { Grade: "7A+" } },
      { DateClimbedAsString: "15 Nov 2023", NumberOfTries: "Project", Problem: { Grade: "8A" } },
      { NumberOfTries: "Flashed", Problem: { Grade: "6C" } }, // undated
    ]);
    expect(ascents).toHaveLength(1);
    expect(ascents[0]!.vGrade).toBe(7);
  });
});

describe("connectMoonboard (mocked fetch)", () => {
  it("logs in via cookie jar and returns a serialized-token result", async () => {
    const loginHtml = `<input name="__RequestVerificationToken" value="CSRF1"><input name="form_key" value="FK1">`;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/account/login")) {
        return new Response(loginHtml, {
          status: 200,
          headers: { "set-cookie": "ARRAffinity=abc; path=/" },
        });
      }
      if (u.endsWith("/Account/login")) {
        return new Response("", {
          status: 302,
          headers: { "set-cookie": ".AspNet.ApplicationCookie=sess; path=/", location: "/" },
        });
      }
      if (u.endsWith("/Logbook/GetLogbook")) {
        // Only the first setup returns a row; the rest are empty.
        const body = String(init?.body ?? "");
        const first = body.includes("'1'");
        return new Response(
          JSON.stringify({
            Total: first ? 1 : 0,
            Data: first
              ? [{ DateClimbedAsString: "15 Nov 2023", NumberOfTries: "Flashed", Problem: { Grade: "7A+" } }]
              : [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await connectMoonboard({ username: "u", password: "p" }, { fetch: fakeFetch });
    expect(res.board).toBe("moonboard");
    expect(res.token).toContain(".AspNet.ApplicationCookie=sess");
    expect(res.ascents).toHaveLength(1);
    expect(res.ascents[0]!.vGrade).toBe(7);
  });

  it("throws bad-credentials when login neither redirects nor sets an auth cookie", async () => {
    const loginHtml = `<input name="__RequestVerificationToken" value="CSRF1">`;
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/account/login")) return new Response(loginHtml, { status: 200 });
      if (u.endsWith("/Account/login")) return new Response(loginHtml, { status: 200 }); // re-rendered form
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      connectMoonboard({ username: "u", password: "bad" }, { fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: "bad-credentials" });
  });
});
