# Offline climb catalog (`db` module)

Aurora's `/sync` returns each ascent's `climb_uuid` but no climb name, and syncing the whole `climbs`
table live is huge. The Aurora boards ship their full catalog as `assets/db.sqlite3` inside their
Android APK, with a `climbs` table (`uuid -> name`, plus `frames` and layout metadata). Downloading
that once resolves names locally with zero per-climb API calls. This is what fixes the previously
blank Tension climb names.

## What it does

`boardlink.db` downloads the board's bundled sqlite catalog to a local cache and resolves climb data
from it, cache-first:

- `download_board_db(board, dest=None, force=False) -> str` - fetch the APK, extract
  `assets/db.sqlite3` to the cache, return the path. Reuses an existing file unless `force=True`.
- `open_board_db(path)` - read-only connection context manager.
- `climb_names(path_or_conn, uuids) -> {uuid: name}` - one parameterized query for a batch of uuids;
  `climb_name(path_or_conn, uuid)` is the single-lookup convenience.
- `climb_frames(path_or_conn, uuids) -> {uuid: frames}` - the `p<placement>r<role>` layout string
  (grades are **not** in the `climbs` table; they live in `climb_stats` and are out of scope here).

### `climbs` table schema (verified against a downloaded catalog)

Columns: `uuid` (PK), `layout_id`, `setter_id`, `setter_username`, `name`, `description`, `hsm`,
`edge_left/right/bottom/top`, `angle`, `frames_count`, `frames_pace`, `frames`, `is_draft`,
`is_listed`, `created_at`, `is_nomatch`. There is no `difficulty` column.

## Two ways to resolve Tension names: `web` vs `db`

There are two strategies for turning Tension's bare `climb_uuid`s into names. `connect_tension` selects
between them via `resolve_names`:

```python
connect_tension(username=None, password=None, *, token=None, db_path=None, resolve_names=False)
```

Precedence, highest first:

- `db_path=...` - always forces the offline-catalog path, using that catalog file directly.
- `resolve_names="web"` - the lightweight web resolver (see below). Ignored when `db_path` is set.
- `resolve_names="db"` (or the legacy `True`) - download the ~87MB catalog (cache-first) if absent,
  then resolve offline. After the sync all `climb_uuid`s are resolved in one batch query.
- `resolve_names=False`/`None` (default) - resolve only if a catalog is already cached; else blank.

Either way, resolved names are written to `Ascent.climb_name`; unresolved uuids stay blank.

### `web` - per-climb page scrape (`webnames` module)

Each Aurora board serves a public, unauthenticated page per climb at `<web_host>/climbs/<uuid>`
(Tension: `https://tensionboardapp2.com`) whose climb name is in both the `<title>` and `<h1>`.
`resolve_climb_names(board, uuids)` fetches those pages sequentially over one reused `requests.Session`
with the Aurora app User-Agent, extracts the name (`<title>`, falling back to `<h1>`), and
`html.unescape`s it. A 404 (unlisted/deleted) or any non-200 leaves that uuid blank and is **not**
raised.

Resolved names are persisted to a name cache at `$XDG_CACHE_HOME/boardlink/<board>-names.json`
(default `~/.cache/boardlink/tension-names.json`), written atomically. Resolution is cache-first: only
uuids not already cached are fetched, and the cache is robust to a missing or corrupt file (treated as
empty). Misses are never cached, so a climb published later is re-fetched rather than remembered blank.
Caching names is safe because a climb's name is static.

### Trade-offs

- **`web`** - no big download; N small, cacheable HTTP requests (one per uncached climb). Best for a
  small logbook or when you cannot afford the ~87MB pull. Downsides: it depends on the public web
  page's HTML staying scrapeable (a layout change could break extraction), and it is online-only for
  the first sight of each new climb. After the first resolve, cached climbs cost zero requests.
- **`db`** - one ~87MB download, then zero per-climb requests and fully offline, with the whole catalog
  available (names, frames, layout metadata). Best for large logbooks or repeated/offline use.
  Downside: the upfront download and a point-in-time snapshot that goes stale (see caveats above).

## Logbook caching is the application's job

Only the static name cache is stored by the connector; the logbook itself is intentionally not cached
- the connector stays stateless and re-syncs on each call, leaving logbook persistence to the
application. Aurora's incremental `/sync` (a `since`-date parameter, currently pinned to the epoch) is
the future lever for cheap delta syncs once an app keeps its own logbook store.

## Deploying apps: caching backends

The defaults above assume a CLI/desktop process with a writable `~/.cache`. Two knobs make the caches
work in a deploy (serverless, multi-worker servers) instead.

Both the name cache and the catalog are **global, static** data - a climb's name and layout are the
same for every user, not per-account - so one shared backing store safely serves all of an app's
users. (The per-user logbook is a separate concern; see below.)

### `BOARDLINK_CACHE_DIR` - relocate the file caches

`_cache_dir()` (which both `default_db_path` and `default_names_path` flow through) resolves the base
directory with this precedence, highest first:

1. an explicit path the caller passes (`db_path=`, `cache_path=`),
2. `BOARDLINK_CACHE_DIR`,
3. `XDG_CACHE_HOME/boardlink`,
4. `~/.cache/boardlink`.

Point `BOARDLINK_CACHE_DIR` at a **persistent, writable volume** so a server keeps the ~87MB catalog
and the name JSON across restarts instead of re-downloading on every cold start. Serverless functions
with an ephemeral/read-only filesystem should avoid the `db` (catalog) path entirely - the 87MB pull
is a non-starter on cold start - and use the `web` resolver with a shared name cache (below).

### Pluggable `NameCache` - back names with Redis/DB/S3

The `web` resolver reads and writes names through a tiny, dependency-free protocol
(`boardlink.cache.NameCache`), so a deploy can swap the default JSON file for a shared store without
touching the connector. Because names resolve in batches, the interface is batch-shaped:

```python
class NameCache(Protocol):
    def get_many(self, keys: list[str]) -> dict[str, str]: ...  # only the known keys
    def set_many(self, mapping: dict[str, str]) -> None: ...
```

The default implementation is `FileNameCache(path)` - the JSON behavior described above (atomic
temp + `os.replace`, missing/corrupt file treated as empty, `ensure_ascii=False`, misses never
stored). To use your own store, implement the two methods and inject it:

```python
class RedisNameCache:
    def __init__(self, client, prefix="boardlink:names:"):
        self.client, self.prefix = client, prefix
    def get_many(self, keys):
        vals = self.client.mget([self.prefix + k for k in keys])
        return {k: v for k, v in zip(keys, vals) if v is not None}
    def set_many(self, mapping):
        if mapping:
            self.client.mset({self.prefix + k: v for k, v in mapping.items()})

connect_tension(token=tok, resolve_names="web", cache=RedisNameCache(redis_client))
# or, calling the resolver directly:
resolve_climb_names("tension", uuids, cache=RedisNameCache(redis_client))
```

`cache=` takes precedence over `cache_path=`; when neither is given the default `FileNameCache` at the
per-board path is used, so existing `cache_path=`/`db_path=` callers behave exactly as before.
boardlink ships **no** Redis/S3 dependency - the app supplies its own implementation.

### Logbook caching stays the app's job

Only the global-static name/catalog caches are stored by boardlink. The per-user logbook is
intentionally **not** cached - the connector is stateless and re-syncs on each call, leaving logbook
persistence to the application. Aurora's incremental `/sync` (a `since`-date parameter, currently
pinned to the epoch) is the future lever for cheap delta syncs once an app keeps its own logbook
store. The TypeScript SDK implements the same `db`, `webnames`, and `NameCache` surface (see below).

## Download source and cache location

The catalog is pulled from the board's latest Android APK via APKPure
(`https://d.apkpure.net/b/APK/com.auroraclimbing.<package>`, `tension -> tensionboard2`,
`kilter -> kilterboard`). The response is an XAPK/zip bundle; the payload APK (itself a zip) holds
`assets/db.sqlite3`, with a fallback for older single-APK bundles that expose it at the top level.

The cache lives outside the repo, at `$XDG_CACHE_HOME/boardlink/<board>.sqlite3` (default
`~/.cache/boardlink/<board>.sqlite3`). The download is written atomically via a temp file.

## Caveats

- **Cache-first / stale snapshot.** The cached catalog is a point-in-time snapshot. Newly set climbs
  will be missing until you re-download with `force=True` (or delete the cache). Unknown uuids simply
  resolve to no name.
- **Legal / data.** The sqlite catalog is proprietary board data. It is downloaded on demand for
  personal use to a local cache; do not redistribute or commit the APK, the sqlite, or any extracted
  catalog data. Nothing here is committed to the repo.
- **Scope: Aurora only.** Tension and the legacy Aurora Kilter catalog. The current Kilter app has
  left Aurora and enriches names server-side (see `kilter.py`). MoonBoard is a separate, unrelated
  app and is not covered.

## TypeScript port

Implemented. `@boardlink/core` ships `db`, `webnames`, and `cache` modules mirroring this Python
surface. To stay dependency-free it uses Node's built-in `node:sqlite` (rather than the native
`better-sqlite3` addon), which raises the minimum runtime to Node 22+; it is loaded lazily behind a
guard that throws an actionable error on older runtimes, and the APK download and zip extraction use
`fetch` plus `node:zlib`. The read-only queries mirror this module exactly.
