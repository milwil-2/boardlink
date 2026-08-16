# Tension Board app API (reverse-engineered)

Tension still runs on the **Aurora Climbing** backend (the same platform Kilter used before it split
off in 2025). The flow is the classic Aurora one: `POST /sessions` for a session token, then
`POST /sync` for the logbook. This was live-verified against a real account (login, sync, dates,
angles, tries, and raw records all confirmed).

Backend host: **`tensionboardapp2.com`**.

One gotcha shapes everything below: the `/sync` route is gated on a native-app `User-Agent`. Without
it the server returns 404, even though login on `/sessions` works fine. That is why a session can
authenticate successfully while the logbook fetch silently 404s.

```
User-Agent: Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0
```

The `%20` is a literal (the URL-encoded "Kilter Board" app name). The Aurora app ships this same
string for Tension, so boardlink sends it verbatim on every Aurora call.

---

## 1. Auth - session token (fully understood)

`POST /sessions`

Headers: `accept: application/json`, the native-app `User-Agent` above.

Request JSON:
```json
{
  "username": "<username>",
  "password": "<password>",
  "tou": "accepted",
  "pp": "accepted",
  "ua": "app"
}
```

- **Aurora authenticates by username, not email.** Passing an email is the most common cause of a
  rejected login. A `401` or `422` is treated as bad credentials.
- The token is read from `session` or `token` in the response body (it may be nested as
  `session.token`). boardlink stores only this token; the password is used once and never persisted.

Re-sync without the password: pass the stored token straight back (`connect_tension(token=...)`),
which skips `/sessions` and goes directly to `/sync`.

---

## 2. Logbook - `POST /sync` (fully understood)

`POST /sync`

Headers: `content-type: application/x-www-form-urlencoded`, `accept: application/json`,
the native-app `User-Agent`, and `Cookie: token=<session>`.

Request body (form-urlencoded):
```
ascents=1970-01-01 00:00:00.000000   (URL-encoded)
```

The date is a "changed since" watermark. Sending the epoch pulls the full history. A `401` means the
session expired.

Response JSON contains an `ascents` array. Each raw ascent carries:
```
uuid, climb_uuid, angle, is_mirror, is_listed, attempt_id, bid_count,
difficulty (int), quality, comment, climbed_at (timestamp), created_at, updated_at
```

Normalization rules boardlink applies:
- Rows with `is_listed: false` are skipped.
- Rows without `climbed_at` are skipped (not a real send).
- **Tries:** `attempt_id` when set is the tries count (`1` = flash). Otherwise a send is
  `bid_count + 1` (recorded fails plus the send).
- `angle`, `is_mirror`, and `comment` map straight through; the full record is kept in `raw`.
- **Grade** comes from the integer `difficulty` via the bundled difficulty table (see below); the
  sync does not return the grade table itself.

---

## 3. Climb names - not in the sync (the gap)

Aurora's `/sync` returns `climb_uuid` but **not the climb name**. Names live in the app's bundled
climbs catalog, not in the sync payload, so `climbName` stays blank unless the caller opts into a
resolution strategy. Precedence, highest first:

1. **`db_path=...`** - use a specific offline catalog file directly (always wins).
2. **`resolve_names="web"`** - scrape each climb's public web page. No large download; N small,
   cacheable requests, optionally backed by a `NameCache` (Redis/DB/S3). See `webnames`.
3. **`resolve_names="db"`** (or the legacy `True`) - download the catalog database (cache-first) if it
   is not already cached, then resolve offline. See `docs/database.md` for how the catalog is pulled
   from the app's APK.
4. **`resolve_names=False` / `None`** (default) - resolve only if a catalog is already cached;
   otherwise names stay blank.

Live result: with resolution enabled, all 46 ascents on the test account resolved to real names
(e.g. "Rebuilt", "Might of Manon").

---

## 4. Difficulty -> grade table

`difficulty` is an integer on the shared Aurora scale (ids roughly 1 to 39), the same family Kilter
uses. boardlink bundles this mapping as a constant (`difficulty.py` / `difficulty.ts`), so grades
are produced offline with no extra request. The full table and cross-system mappings
(font / V / French / YDS) are in `docs/kilter-new-api.md`.

**Open item (honest):** Tension's grade scale may be narrower than Kilter's (it has been described as
"V0 to V15"), so the difficulty-to-grade mapping for Tension is not 100% confirmed. The plan to
verify it is offline: pull Tension's bundled catalog (Section 3, the `db` path) and diff its
`difficulty_grades` table against the bundled constant, rather than guessing. Until then, Tension
grades assume the shared Aurora scale.

---

## Resolved / remaining

- **Auth - done.** `POST /sessions` by username; store the returned token.
- **Read path - done.** `POST /sync` with the native-app User-Agent and `Cookie: token=...`;
  the User-Agent gate is the key finding.
- **Names - done.** Not in the sync; resolved via the offline catalog or the per-climb web scrape.
- **Still open:** confirming Tension's difficulty-to-grade scale against its own catalog table.
