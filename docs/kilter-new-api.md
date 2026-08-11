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
| `sync1.kiltergrips.com` | PowerSync streaming sync (bulk data incl. logbook) |

All `portal` and `sync` calls send `Authorization: Bearer <access_token>` from Keycloak.

---

## 1. Auth — Keycloak OIDC + PKCE (fully understood)

Realm: `kilter`. Public client `client_id=kilter` (no secret, PKCE S256).
Redirect URI: `com.kiltergrips:/oauthredirect`. Discovery doc (public):
`https://idp.kiltergrips.com/realms/kilter/.well-known/openid-configuration`

Flow (Authorization Code + PKCE):
1. `GET /realms/kilter/protocol/openid-connect/auth` — params: `response_type=code`,
   `scope=openid offline_access`, `code_challenge`, `code_challenge_method=S256`, `redirect_uri`,
   `client_id=kilter`, `state`, `nonce`. Returns login HTML + `KC_*` session cookie.
   (The app opens this in an iOS system web session, hence a Safari User-Agent.)
2. `POST /realms/kilter/login-actions/authenticate?session_code=…&execution=…&tab_id=…` —
   form body `username`, `password` → **302** to `com.kiltergrips:/oauthredirect?code=…&state=…`
3. `POST /realms/kilter/protocol/openid-connect/token` — form body:
   `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id=kilter`
   → JSON:
   ```
   { access_token (JWT ~1427 chars), expires_in: 14400, refresh_token, refresh_expires_in,
     id_token, token_type: "Bearer", scope: "openid offline_access profile email", session_state }
   ```

Re-sync without password (offline access):
`POST /realms/kilter/protocol/openid-connect/token` with `grant_type=refresh_token`,
`refresh_token`, `client_id=kilter`. **Store only the refresh_token** (token-only design).

Other realm endpoints: `userinfo`, `logout` (end_session), `revoke`, `token/introspect`.

---

## 2. REST API — `portal.kiltergrips.com/api`

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept-Encoding: gzip`.
Many list endpoints accept `?top20=true` (a 20-item preview) — full/paginated variants TBD.

### Write a log / ascent (fully understood)
`POST /api/v2/logs` → `200` (text/plain body). Request JSON:
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

### Climb catalog
`GET /api/climbs/?top20=true` → `{ items: [...], total }`. Item fields:
```
climbUuid, climbConcat ("h1348p15h1400p15…" hold+placement roles), name, userUuid, username,
productName, productLayoutUuid, angle, currentDifficultyId, officialKilterDifficulty,
qualityAverage, faUsername, ascentCount, isLiked, isBlocked, allowMatch,
accumulatedHoldSetValue, frameCount, framesPace, createdAt, updatedAt
```
**Grade** = `currentDifficultyId` / `officialKilterDifficulty` (Aurora-style difficulty integer, e.g.
16, 18). Same scale family as the old Aurora `difficulty_grades` mapping (difficulty → "6C+/V5").

### Other endpoints seen
- `GET /api/climbs/climbdetails/user` → `[]` (user's custom climb details; empty for this account)
- `GET /api/climbs/customactions?newerThan=<ISO>` → `[]` (delta of like/block/etc actions)
- `GET /api/circuits/?top20=true` → `{ items:[{circuitUuid,name,color,username,userUuid,
  productLayoutUuid,count,isPublic,updatedAt}], total }` — **circuits = playlists**
- `GET /api/users/find?top20=true` → `{ items:[{userUuid,username,name,profilePicture,ascents,
  isPublic}], total }` — user search / leaderboard
- `GET /api/climb-rating/{climbUuid}?angle=45` → large JSON (grade/quality vote distribution)
- `GET /api/followers/user` , `GET /api/followers/user/following`
- `GET /api/users/find` (details), `GET /api/image/images/...` (avatars, gym logos)
- `GET /api/app/versions/{version}` (e.g. `2.9.1+58`) — update check

---

## 3. Bulk sync — PowerSync (`sync1.kiltergrips.com`)

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
    /* +2 more buckets not yet un-truncated — likely global_walls + a user-scoped logs bucket */
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
Response: a BSON/ndjson stream of bucket operations (PUT/REMOVE rows) + a checkpoint. With
`after: "0"` on every bucket you get a **full initial sync** (everything); with a prior op id you get
only the delta. It is a long-lived streaming connection (stays open for live updates).

### Write checkpoint
`GET /write-checkpoint2.json?client_id=<uuid>` → `{ "data": { "write_checkpoint": "<n>" } }`
Used after a write to know when the server has synced the change back.

---

## Open questions / TODO to finish the read path
1. **Full bucket list** — un-truncate the `/sync/stream` request to see all 5 bucket names; identify
   which holds the user's logs.
2. **Logbook read** — is there a REST `GET /api/v2/logs` (or `/api/logs/user`), or do the user's
   ascents come only from a PowerSync bucket? Needs a from-scratch sync capture (`after:"0"`) or a
   token test against a candidate GET.
3. **Difficulty → grade** mapping table for the new app (confirm it matches the Aurora scale).
4. **Pagination** for `/api/climbs/`, `/api/circuits/`, `/api/users/find` beyond `top20`.
