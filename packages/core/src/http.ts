export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Cloudflare's interstitial. `cf-mitigated: challenge` is the explicit signal; the body markers are
// the fallback for edges that omit it. Deliberately narrow: a plain 403 from the board's own app
// (a lapsed session) must NOT read as a challenge, or a re-login would be misreported as blocked.
const CHALLENGE_BODY = /Just a moment|cf-chl|cf_chl_opt|Enable JavaScript and cookies/i;

export function isBotChallenge(res: { status: number; headers: Headers }, body = ""): boolean {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  if (res.status !== 403 && res.status !== 503) return false;
  return CHALLENGE_BODY.test(body);
}

// Body-aware variant: only pays for reading the body when the status could plausibly be a
// challenge. Clones first, so the caller can still consume the original response.
export async function detectBotChallenge(res: Response): Promise<boolean> {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  if (res.status !== 403 && res.status !== 503) return false;
  const body = await res
    .clone()
    .text()
    .catch(() => "");
  return CHALLENGE_BODY.test(body);
}

// A cookie jar (name -> value) that serializes back into a Cookie header, for MoonBoard's session.
export type CookieJar = Map<string, string>;

export function addSetCookies(jar: CookieJar, res: Response): void {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const list: string[] =
    anyHeaders.getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
  for (const c of list) {
    const pair = c.split(";")[0]!;
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

export const jarToHeader = (jar: CookieJar): string =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

export function jarFromHeader(s: string): CookieJar {
  const jar: CookieJar = new Map();
  for (const part of s.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}
