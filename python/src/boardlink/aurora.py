from __future__ import annotations

import os
import re
from typing import Optional
from urllib.parse import quote

import requests

from .db import climb_names, default_db_path, download_board_db
from .difficulty import grade_for_difficulty
from .types import Ascent, BoardError, ConnectResult

# Tension still runs on Aurora: POST /sessions for a token, then POST /sync for the logbook. The sync
# returns each ascent's integer difficulty but not the grade table, so grades come from the bundled
# Aurora difficulty table (see difficulty.py).
TENSION_WEB = "https://tensionboardapp2.com"
_BASE_SYNC_DATE = "1970-01-01 00:00:00.000000"
# The /sync route is gated on a native-app User-Agent; without it the server 404s. The %20 is a
# literal, from the URL-encoded "Kilter Board" app name; the app sends this same string for Tension.
_AURORA_UA = "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0"


def connect_tension(
    username: Optional[str] = None,
    password: Optional[str] = None,
    *,
    token: Optional[str] = None,
    db_path: Optional[str] = None,
    resolve_names: bool = False,
) -> ConnectResult:
    """Connect to Tension and return the normalized logbook.

    Aurora's /sync omits climb names. They stay blank unless the caller opts into offline resolution:
    pass ``db_path`` to use an existing catalog, ``resolve_names=True`` to download it (cache-first,
    ~100MB) if absent, or leave both unset and a cached catalog is used automatically when present.
    """
    session = token or _login("tension", TENSION_WEB, username, password)
    data = _sync("tension", TENSION_WEB, session)
    ascents = _sync_to_ascents("tension", data)
    path = _catalog_path(db_path, resolve_names)
    if path:
        _fill_climb_names(ascents, path)
    return ConnectResult("tension", session, ascents)


def _catalog_path(db_path: Optional[str], resolve_names: bool) -> Optional[str]:
    if db_path:
        return db_path
    if resolve_names:
        return download_board_db("tension")
    cached = default_db_path("tension")
    return cached if os.path.exists(cached) else None


def _fill_climb_names(ascents, path) -> None:
    uuids = [a.raw.get("climb_uuid") for a in ascents if a.raw]
    names = climb_names(path, uuids)
    for a in ascents:
        name = names.get((a.raw or {}).get("climb_uuid"))
        if name:
            a.climb_name = name


def _login(board, host, username, password) -> str:
    if not username or not password:
        raise BoardError("missing-credentials", "username and password required", board)
    try:
        r = requests.post(
            f"{host}/sessions",
            json={"username": username, "password": password, "tou": "accepted", "pp": "accepted", "ua": "app"},
            headers={"accept": "application/json", "User-Agent": _AURORA_UA},
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach the board service", board) from e
    if r.status_code in (401, 422):
        # Aurora authenticates by username, not email - a common cause of this rejection.
        raise BoardError("bad-credentials", "Incorrect username or password.", board)
    if not r.ok:
        raise BoardError("unexpected-response", f"login failed ({r.status_code})", board)
    body = r.json()
    session = body.get("session") or body.get("token")
    if isinstance(session, dict):
        session = session.get("token")
    if not session:
        raise BoardError("unexpected-response", "no session token returned", board)
    return session


def _sync(board, host, token) -> dict:
    body = f"ascents={quote(_BASE_SYNC_DATE)}"
    try:
        r = requests.post(
            f"{host}/sync",
            data=body,
            headers={
                "content-type": "application/x-www-form-urlencoded",
                "accept": "application/json",
                "User-Agent": _AURORA_UA,
                "Cookie": f"token={token}",
            },
            timeout=60,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach the board service", board) from e
    if r.status_code == 401:
        raise BoardError("session-expired", "session expired", board)
    if not r.ok:
        raise BoardError("unexpected-response", f"sync failed ({r.status_code})", board)
    return r.json()


def _normalize_date(s: str) -> str:
    iso = s if "T" in s else s.replace(" ", "T", 1)
    if iso.endswith("Z") or re.search(r"[+-]\d\d:?\d\d$", iso):
        return iso
    return iso + "Z"


def _to_ascent(board, raw) -> Optional[Ascent]:
    climbed = raw.get("climbed_at")
    if not climbed:
        return None
    grade_info = grade_for_difficulty(raw.get("difficulty"))
    grade = grade_info["label"] if grade_info else None
    # attempt_id, when set, is the tries count (1 = flash); otherwise a send took bid_count fails + 1.
    tries = raw.get("attempt_id") or (raw.get("bid_count") or 0) + 1
    return Ascent(
        board=board,
        climb_name="",  # Aurora's sync omits names; resolving them needs the climbs table (see docs)
        date=_normalize_date(climbed),
        grade=grade,
        user_grade=grade,
        v_grade=grade_info["v_grade"] if grade_info else None,
        tries=tries,
        angle=raw.get("angle"),
        is_mirror=bool(raw.get("is_mirror")),
        raw=raw,
    )


def _sync_to_ascents(board, resp) -> list:
    out = []
    for raw in resp.get("ascents") or []:
        if raw.get("is_listed") is False:
            continue
        a = _to_ascent(board, raw)
        if a:
            out.append(a)
    return out
