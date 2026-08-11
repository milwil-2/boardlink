export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

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
