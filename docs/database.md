# Offline climb catalog (`db` module)

Aurora's `/sync` returns each ascent's `climb_uuid` but no climb name, and syncing the whole `climbs`
table live is huge. The Aurora boards ship their full catalog as `assets/db.sqlite3` inside their
Android APK, with a `climbs` table (`uuid -> name`, plus `frames` and layout metadata). Downloading
that once resolves names locally with zero per-climb API calls. This is what fixes the previously
blank Tension climb names.

## What it does

`boardlink.db` downloads the board's bundled sqlite catalog to a local cache and resolves climb data
from it, cache-first:

- `download_board_db(board, dest=None, force=False) -> str` — fetch the APK, extract
  `assets/db.sqlite3` to the cache, return the path. Reuses an existing file unless `force=True`.
- `open_board_db(path)` — read-only connection context manager.
- `climb_names(path_or_conn, uuids) -> {uuid: name}` — one parameterized query for a batch of uuids;
  `climb_name(path_or_conn, uuid)` is the single-lookup convenience.
- `climb_frames(path_or_conn, uuids) -> {uuid: frames}` — the `p<placement>r<role>` layout string
  (grades are **not** in the `climbs` table; they live in `climb_stats` and are out of scope here).

### `climbs` table schema (verified against a downloaded catalog)

Columns: `uuid` (PK), `layout_id`, `setter_id`, `setter_username`, `name`, `description`, `hsm`,
`edge_left/right/bottom/top`, `angle`, `frames_count`, `frames_pace`, `frames`, `is_draft`,
`is_listed`, `created_at`, `is_nomatch`. There is no `difficulty` column.

## Tension name resolution

`connect_tension` resolves names offline, opt-in so no one is forced into a ~100MB download:

```python
connect_tension(username=None, password=None, *, token=None, db_path=None, resolve_names=False)
```

- `db_path=...` — use an existing catalog file.
- `resolve_names=True` — download the catalog (cache-first) if it is not already cached, then resolve.
- neither set — names are filled only if a catalog is already cached; otherwise they stay blank
  (default behaviour unchanged).

After the sync, all ascent `climb_uuid`s are resolved in one batch query and written to
`Ascent.climb_name`.

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

Not built yet. A TS port needs a SQLite dependency decision: `better-sqlite3` (a native addon —
synchronous, battle-tested, but requires a compile/prebuild step) versus Node's built-in
`node:sqlite` (no dependency, but recent and still marked experimental, so it raises the minimum Node
version). The APK download and zip extraction are straightforward with `fetch` plus a zip library;
the sqlite driver is the only real choice. The read-only queries mirror this module exactly.
