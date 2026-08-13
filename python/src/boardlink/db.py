from __future__ import annotations

import io
import os
import sqlite3
import zipfile
from contextlib import contextmanager, nullcontext
from typing import Iterable, Iterator, Optional, Union

import requests

from .types import BoardError

# The Aurora boards ship their whole climb catalog as assets/db.sqlite3 inside the Android APK.
# APKPure serves the latest build as a downloadable bundle (no account needed); extracting that
# sqlite lets us resolve climb_uuid -> name offline, so the sync's bare uuids never cost a per-climb
# API call. Aurora only: the current Kilter app left Aurora, and MoonBoard is a different app.
_APK_PACKAGES = {
    "tension": "tensionboard2",
    "kilter": "kilterboard",  # legacy Aurora catalog; the live Kilter app is off Aurora now
}
_APKPURE = "https://d.apkpure.net/b/APK/com.auroraclimbing.{package}"
_DB_ENTRY = "assets/db.sqlite3"
# The bundle is ~100MB; allow a generous window but still fail rather than hang forever.
_TIMEOUT = 180
# APKPure 403s a request without a browser User-Agent.
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"

PathOrConn = Union[str, sqlite3.Connection]


def _cache_dir() -> str:
    # BOARDLINK_CACHE_DIR lets a deploy point the (global, static) catalog/name caches at a persistent
    # volume; without it we fall back to the XDG cache, then ~/.cache. Both catalog and name paths flow
    # through here, so one env var relocates the whole cache.
    override = os.environ.get("BOARDLINK_CACHE_DIR")
    if override:
        return override
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "boardlink")


def default_db_path(board: str) -> str:
    return os.path.join(_cache_dir(), f"{board}.sqlite3")


def default_names_path(board: str) -> str:
    return os.path.join(_cache_dir(), f"{board}-names.json")


def _extract_sqlite(bundle: bytes, board: str) -> bytes:
    # APKPure serves an XAPK/zip whose payload APK holds the sqlite; older single-APK bundles expose
    # assets/db.sqlite3 at the top level instead.
    package = _APK_PACKAGES[board]
    try:
        with zipfile.ZipFile(io.BytesIO(bundle)) as bundle_zip:
            names = set(bundle_zip.namelist())
            apk_name = f"com.auroraclimbing.{package}.apk"
            if apk_name in names:
                with zipfile.ZipFile(io.BytesIO(bundle_zip.read(apk_name))) as apk_zip:
                    return apk_zip.read(_DB_ENTRY)
            if _DB_ENTRY in names:
                return bundle_zip.read(_DB_ENTRY)
    except (zipfile.BadZipFile, KeyError) as e:
        raise BoardError("unexpected-response", "could not extract catalog from APK bundle", board) from e
    raise BoardError("unexpected-response", "APK bundle did not contain the climb catalog", board)


def download_board_db(board: str, dest: Optional[str] = None, force: bool = False) -> str:
    """Download the board's APK and extract its bundled sqlite catalog to a gitignored cache path.

    Cache-first: an existing file is reused unless ``force``. Returns the catalog path.
    """
    if board not in _APK_PACKAGES:
        raise BoardError("unexpected-response", f"no bundled catalog for board: {board}", board)
    dest = dest or default_db_path(board)
    if os.path.exists(dest) and not force:
        return dest
    try:
        r = requests.get(
            _APKPURE.format(package=_APK_PACKAGES[board]),
            params={"version": "latest"},
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach the APK source", board) from e
    if not r.ok:
        raise BoardError("unexpected-response", f"APK download failed ({r.status_code})", board)
    data = _extract_sqlite(r.content, board)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = f"{dest}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)  # atomic, so an interrupted write never leaves a partial cached catalog
    return dest


@contextmanager
def open_board_db(path: str) -> Iterator[sqlite3.Connection]:
    """Open the catalog read-only, so a lookup can never mutate the cached snapshot."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        yield conn
    finally:
        conn.close()


def _as_conn(path_or_conn: PathOrConn):
    if isinstance(path_or_conn, sqlite3.Connection):
        return nullcontext(path_or_conn)
    return open_board_db(path_or_conn)


def _resolve(conn: sqlite3.Connection, uuids: Iterable[str], column: str) -> dict:
    # Dedupe while preserving order, drop blanks; nothing to query if empty.
    uniq = [u for u in dict.fromkeys(uuids) if u]
    if not uniq:
        return {}
    out: dict = {}
    # SQLite caps a statement at 999 host parameters; chunk to stay under it.
    for i in range(0, len(uniq), 900):
        chunk = uniq[i : i + 900]
        placeholders = ",".join("?" * len(chunk))
        rows = conn.execute(f"SELECT uuid, {column} FROM climbs WHERE uuid IN ({placeholders})", chunk)
        out.update(dict(rows.fetchall()))
    return out


def climb_names(path_or_conn: PathOrConn, uuids: Iterable[str]) -> dict:
    """Batch-resolve climb_uuid -> name from the ``climbs`` table. Unknown uuids are absent."""
    with _as_conn(path_or_conn) as conn:
        return _resolve(conn, uuids, "name")


def climb_name(path_or_conn: PathOrConn, uuid: str) -> Optional[str]:
    return climb_names(path_or_conn, [uuid]).get(uuid)


def climb_frames(path_or_conn: PathOrConn, uuids: Iterable[str]) -> dict:
    """Batch-resolve climb_uuid -> frames (the p<placement>r<role> layout string)."""
    with _as_conn(path_or_conn) as conn:
        return _resolve(conn, uuids, "frames")
