// A cookie jar (name -> value) that serializes back into a Cookie header, for the Kilter session.
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
