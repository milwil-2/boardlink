from __future__ import annotations

import html
import json
import os
import re
from typing import Dict, Iterable, Optional
from urllib.parse import quote

import requests

from .aurora import TENSION_WEB, _AURORA_UA
from .db import default_names_path
from .types import BoardError

# Each Aurora board serves a public, unauthenticated page per climb at <web_host>/climbs/<uuid> whose
# climb name sits in both the <title> and <h1>. Scraping it resolves names one climb at a time - no
# ~87MB catalog download, just N small requests. Names are static, so a resolved name is cached
# forever; misses are not cached, since an unlisted climb can be published later.
_WEB_HOSTS = {"tension": TENSION_WEB}
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_TIMEOUT = 15


def _extract_name(page: str) -> Optional[str]:
    for pattern in (_TITLE_RE, _H1_RE):
        m = pattern.search(page)
        if m:
            name = html.unescape(m.group(1)).strip()
            if name:
                return name
    return None


def _fetch_name(session: requests.Session, host: str, uuid: str, timeout: int) -> Optional[str]:
    try:
        r = session.get(
            f"{host}/climbs/{quote(uuid)}",
            headers={"User-Agent": _AURORA_UA, "accept": "text/html"},
            timeout=timeout,
        )
    except requests.RequestException:
        return None  # transient/unreachable: leave unresolved rather than fail the whole run
    if r.status_code != 200:
        return None  # 404 for unlisted/deleted climbs; anything non-200 stays blank
    return _extract_name(r.text)


def _load_cache(path: str) -> Dict[str, str]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}  # missing or corrupt cache is treated as empty
    return data if isinstance(data, dict) else {}


def _save_cache(path: str, cache: Dict[str, str]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, path)  # atomic, so an interrupted write never corrupts the cache


def resolve_climb_names(
    board: str,
    uuids: Iterable[str],
    *,
    cache_path: Optional[str] = None,
    session: Optional[requests.Session] = None,
    timeout: int = _TIMEOUT,
) -> Dict[str, str]:
    """Resolve climb_uuid -> name by scraping each climb's public web page, cache-first.

    Loads the on-disk name cache, fetches only the uuids not already cached (sequentially, reusing one
    Session), merges the newly resolved names back into the cache, and persists. Returns the resolved
    subset (cached + newly fetched); unresolved uuids are simply absent. Never raises on a fetch
    failure - a 404 or unreachable climb just stays blank and is not cached.
    """
    if board not in _WEB_HOSTS:
        raise BoardError("unexpected-response", f"no web catalog for board: {board}", board)
    host = _WEB_HOSTS[board]
    path = cache_path or default_names_path(board)
    cache = _load_cache(path)

    uniq = [u for u in dict.fromkeys(uuids) if u]
    resolved = {u: cache[u] for u in uniq if u in cache}
    missing = [u for u in uniq if u not in cache]
    if not missing:
        return resolved

    owns_session = session is None
    session = session or requests.Session()
    try:
        fetched = {}
        for uuid in missing:
            name = _fetch_name(session, host, uuid, timeout)
            if name:
                fetched[uuid] = name
    finally:
        if owns_session:
            session.close()

    if fetched:
        cache.update(fetched)
        _save_cache(path, cache)
        resolved.update(fetched)
    return resolved
