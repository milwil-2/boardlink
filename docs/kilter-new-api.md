# New Kilter Board app API (reverse-engineered)

The Kilter Board split from Aurora Climbing in March 2025 and shipped its own app. This is the
backend of that **new** app (Flutter/Dart, `User-Agent: Dart/3.10 (dart:io)`; app version seen:
`2.9.1+58`). It is unrelated to the old Aurora `/sessions`+`/sync` API (which boardlib still uses and
which no longer serves Kilter). Captured live via mitmproxy (WireGuard mode) against a real account.

Company backend domain: **`kiltergrips.com`**. Three services:

| Host | Role |
|---|---|
| `idp.kiltergrips.com` | Keycloak identity provider (auth) |
| `portal.kiltergrips.com` | REST API (`/api/...`) |
| `sync1.kiltergrips.com` | PowerSync streaming sync (bulk board data: holds/walls/geometry) |

All `portal` and `sync` calls send `Authorization: Bearer <access_token>` from Keycloak.

---

## 1. Auth - Keycloak OIDC + PKCE (fully understood)

Realm: `kilter`. Public client `client_id=kilter` (no secret, PKCE S256).
Redirect URI: `com.kiltergrips:/oauthredirect`. Discovery doc (public):
`https://idp.kiltergrips.com/realms/kilter/.well-known/openid-configuration`

Flow (Authorization Code + PKCE):
1. `GET /realms/kilter/protocol/openid-connect/auth` - params: `response_type=code`,
   `scope=openid offline_access`, `code_challenge`, `code_challenge_method=S256`, `redirect_uri`,
   `client_id=kilter`, `state`, `nonce`. Returns login HTML + `KC_*` session cookie.
   (The app opens this in an iOS system web session, hence a Safari User-Agent.)
2. `POST /realms/kilter/login-actions/authenticate?session_code=...&execution=...&tab_id=...` -
   form body `username`, `password` -> **302** to `com.kiltergrips:/oauthredirect?code=...&state=...`
3. `POST /realms/kilter/protocol/openid-connect/token` - form body:
   `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id=kilter`
   -> JSON:
   ```
   { access_token (JWT ~1427 chars), expires_in: 14400, refresh_token, refresh_expires_in,
     id_token, token_type: "Bearer", scope: "openid offline_access profile email", session_state }
   ```

Re-sync without password (offline access):
`POST /realms/kilter/protocol/openid-connect/token` with `grant_type=refresh_token`,
`refresh_token`, `client_id=kilter`. **Store only the refresh_token** (token-only design).

Other realm endpoints: `userinfo`, `logout` (end_session), `revoke`, `token/introspect`.

---

## 2. REST API - `portal.kiltergrips.com/api`

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept-Encoding: gzip`.
Many list endpoints accept `?top20=true` (a 20-item preview) - full/paginated variants TBD.

### Write a log / ascent (fully understood)
`POST /api/v2/logs` -> `200` (text/plain body). Request JSON:
```json
{
  "id": "<uuid>",
  "logUuid": "<uuid, same as id>",
  "userUuid": "<uuid>",
  "gymUuid": "149208",
  "wallUuid": "<uuid>",
  "productLayoutUuid": "10",
  "climbUuid": "<CLIMB_UUID hex>",
  "angle": 45,
  "topped": 1,
  "flashed": 1,
  "attempts": 1,
  "createdAt": "2026-08-10T03:38:57.731741Z"
}
```

### Read the logbook (fully understood - this is the ascent read path)
`GET /api/logs` -> `200`, a JSON array of the **authenticated** user's ascents. No id in the path: the
bearer token identifies the user. The server joins the climb name and current difficulty in, so no
catalog lookup is needed. Item fields:
```
logUuid, climbUuid, userUuid, gymUuid, wallUuid, productLayoutUuid, angle,
flashed (bool), topped (bool), attempts (int), createdAt (ISO), climbName,
currentDifficultyId (int -> difficulty_grades id), climbRating? { difficultyGradeId, rating, ... }
```
`climbRating`, when present, is the user's own grade/quality submission for that climb.

Note the sibling form: `GET /api/logs/{userId}` returns **another** user's *public* logs (by numeric
id). It returns `[]` for a uuid or username, and for the owner - it is not the way to read your own
logbook. Use the bare `GET /api/logs`.

### Climb catalog
`GET /api/climbs/?top20=true` -> `{ items: [...], total }`. Item fields:
```
climbUuid, climbConcat ("h1348p15h1400p15..." hold+placement roles), name, userUuid, username,
productName, productLayoutUuid, angle, currentDifficultyId, officialKilterDifficulty,
qualityAverage, faUsername, ascentCount, isLiked, isBlocked, allowMatch,
accumulatedHoldSetValue, frameCount, framesPace, createdAt, updatedAt
```
**Grade** = `currentDifficultyId` / `officialKilterDifficulty` (Aurora-style difficulty integer, e.g.
16, 18). Same scale family as the old Aurora `difficulty_grades` mapping (difficulty -> "6C+/V5").

### Other endpoints seen
- `GET /api/climbs/climbdetails/user` -> `[]` (user's custom climb details; empty for this account)
- `GET /api/climbs/customactions?newerThan=<ISO>` -> `[]` (delta of like/block/etc actions)
- `GET /api/circuits/?top20=true` -> `{ items:[{circuitUuid,name,color,username,userUuid,
  productLayoutUuid,count,isPublic,updatedAt}], total }` - **circuits = playlists**
- `GET /api/users/find?top20=true` -> `{ items:[{userUuid,username,name,profilePicture,ascents,
  isPublic}], total }` - user search / leaderboard
- `GET /api/climb-rating/{climbUuid}?angle=45` -> large JSON (grade/quality vote distribution)
- `GET /api/followers/user` , `GET /api/followers/user/following`
- `GET /api/users/find` (details), `GET /api/image/images/...` (avatars, gym logos)
- `GET /api/app/versions/{version}` (e.g. `2.9.1+58`) - update check

---

## 3. Bulk sync - PowerSync (`sync1.kiltergrips.com`)

The app's local data (climbs, gyms, walls, and the user's logs) is kept in a local SQLite mirrored
via **PowerSync** (`User-Agent: powersync-dart-core/1.7.0`). Protocol is open source
(github.com/powersync-ja). Auth: same Keycloak `Bearer` token.

### Sync stream
`POST /sync/stream`
Headers: `Accept: application/vnd.powersync.bson-stream;q=0.9,application/x-ndjson;q=0.8`.
Request JSON:
```json
{
  "buckets": [
    { "name": "global[]",        "after": "<opid or 0>" },
    { "name": "global_climbs[]", "after": "<opid>" },
    { "name": "global_gyms[]",   "after": "<opid>" }
    /* +2 more buckets not yet un-truncated - likely global_walls + a user-scoped logs bucket */
  ],
  "include_checksum": true,
  "raw_data": true,
  "binary_data": true,
  "client_id": "<client uuid>",
  "parameters": {},
  "streams": { "include_defaults": true, "subscriptions": [] },
  "app_metadata": {}
}
```
Response: a BSON/ndjson stream of bucket operations (PUT/REMOVE rows) + a `checkpoint`, the bucket
data, then `checkpoint_complete`. It is a long-lived connection (stays open for live updates), so
read until `checkpoint_complete` and stop. The `buckets` array is **resumption state, not a filter**:
the server derives the actual bucket set from `streams.include_defaults`, so requesting fewer buckets
changes nothing. Use `include_defaults: true` and a single `{ "name": "global[]", "after": "0" }` to
pull everything.

A full sync (`after: "0"`) carries these object types (row counts from one account):
```
global[]         -> difficulty_grades (39), product_layouts, mounting_holes, logs (the user's), ...
global_gyms[]    -> gyms, walls, ...
global_climbs[]  -> climb_beta_links, hold_placements, holds   (hold GEOMETRY, ~36k rows)
```
Two things this settles:
- **There is no climb catalog (names/grades) in PowerSync.** `global_climbs[]` is hold geometry, not
  climb metadata. Climb names come from REST (`GET /api/logs` for the logbook; `/api/climbs/?name=`
  for search). There is no `GET /api/climbs/{uuid}` by-uuid endpoint.
- **The synced `logs` rows are bare** (`climb_uuid, angle, flashed, topped, attempts, created_at` -
  no name, no grade). The enriched, name+grade-joined logbook is the REST `GET /api/logs` above.

So PowerSync is only needed for raw board data (holds/walls/geometry, e.g. to render a climb); the
ascent read path is pure REST.

### Write checkpoint
`GET /write-checkpoint2.json?client_id=<uuid>` -> `{ "data": { "write_checkpoint": "<n>" } }`
Used after a write to know when the server has synced the change back.

---

## Difficulty -> grade table

`currentDifficultyId` / `difficultyGradeId` index the static `difficulty_grades` table (ids 1-39,
synced in the `global[]` bucket). It is the classic Aurora scale, so each id maps across systems.
boardlink bundles this as a constant (`KILTER_DIFFICULTY_GRADES`) rather than syncing it.

| id | Font/V | French | YDS | | id | Font/V | French | YDS |
|---|---|---|---|---|---|---|---|---|
| 10 | 4A/V0 | 5b | 5.9 | | 25 | 7B+/V8 | 8a+ | 5.13c |
| 13 | 5A/V1 | 6a+ | 5.10c | | 26 | 7C/V9 | 8b | 5.13d |
| 15 | 5C/V2 | 6b+ | 5.11a | | 27 | 7C+/V10 | 8b+ | 5.14a |
| 16 | 6A/V3 | 6c | 5.11b | | 28 | 8A/V11 | 8c | 5.14b |
| 18 | 6B/V4 | 7a | 5.11d | | 30 | 8B/V13 | 9a | 5.14d |
| 20 | 6C/V5 | 7b | 5.12b | | 32 | 8C/V15 | 9b | 5.15b |
| 22 | 7A/V6 | 7c | 5.12d | | 34 | 9A/V17 | 9c | 5.15d |
| 23 | 7A+/V7 | 7c+ | 5.13a | | 39 | 9C+/V22 | 10b+ | 5.17a |

(Abridged; ids 1-39 are contiguous. Full table in `packages/core/src/kilter.ts`.)

## Resolved / remaining

- **Read path - done.** The logbook is `GET /api/logs` (enriched with name + `currentDifficultyId`);
  grades come from the bundled difficulty table. No PowerSync needed for ascents.
- **PowerSync buckets - done.** `buckets` is resumption state, not a selector; `global_climbs[]` is
  hold geometry, not climb metadata; the user's `logs` sync bare (no name/grade).
- **Difficulty mapping - done.** Table above.
- **Still open (not needed for boardlink):** pagination for `/api/climbs/`, `/api/circuits/`,
  `/api/users/find` beyond `top20`; the `climbConcat` hold-role encoding for rendering climbs.
