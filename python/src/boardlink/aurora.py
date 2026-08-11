from __future__ import annotations

import re
from typing import Optional
from urllib.parse import quote

import requests

from .grades import parse_v_grade
from .types import Ascent, BoardError, ConnectResult

# Tension still runs on Aurora: POST /sessions for a token, then POST /sync for the logbook.
TENSION_WEB = "https://tensionboardapp2.com"
_BASE_SYNC_DATE = "1970-01-01 00:00:00.000000"


def connect_tension(username: Optional[str] = None, password: Optional[str] = None, *, token: Optional[str] = None) -> ConnectResult:
    session = token or _login("tension", TENSION_WEB, username, password)
    data = _sync("tension", TENSION_WEB, session)
    return ConnectResult("tension", session, _sync_to_ascents("tension", data))


def _login(board, host, username, password) -> str:
    if not username or not password:
        raise BoardError("missing-credentials", "username and password required", board)
    try:
        r = requests.post(
            f"{host}/sessions",
            json={"username": username, "password": password, "tou": "accepted", "pp": "accepted", "ua": "app"},
            headers={"accept": "application/json"},
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach the board service", board) from e
    if r.status_code in (401, 422):
        raise BoardError("bad-credentials", "Incorrect board email or password.", board)
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
    body = "&".join(f"{t}={quote(_BASE_SYNC_DATE)}" for t in ("ascents", "bids", "difficulty_grades"))
    try:
        r = requests.post(
            f"{host}/sync",
            data=body,
            headers={
                "content-type": "application/x-www-form-urlencoded",
                "accept": "application/json",
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


def _difficulty_map(rows) -> dict:
    out = {}
    for row in rows or []:
        name = row.get("boulder_name")
        if name:
            out[round(row.get("difficulty", 0))] = name
    return out


def _approx_v(difficulty: int) -> Optional[str]:
    v = difficulty - 10
    return f"V{v}" if v >= 0 else None


def _normalize_date(s: str) -> str:
    iso = s if "T" in s else s.replace(" ", "T", 1)
    if iso.endswith("Z") or re.search(r"[+-]\d\d:?\d\d$", iso):
        return iso
    return iso + "Z"


def _to_ascent(board, raw, difficulty_map) -> Optional[Ascent]:
    climbed = raw.get("climbed_at")
    if not climbed:
        return None
    grade = None
    difficulty = raw.get("difficulty")
    if difficulty is not None:
        d = round(difficulty)
        grade = difficulty_map.get(d) or _approx_v(d)
    return Ascent(
        board=board,
        climb_name="",
        date=_normalize_date(climbed),
        grade=grade,
        user_grade=grade,
        v_grade=parse_v_grade(grade),
        tries=(raw.get("bid_count") or 0) + 1,
        angle=raw.get("angle"),
        is_mirror=bool(raw.get("is_mirror")),
    )


def _sync_to_ascents(board, resp) -> list:
    difficulty_map = _difficulty_map(resp.get("difficulty_grades"))
    out = []
    for raw in resp.get("ascents") or []:
        if raw.get("is_listed") is False:
            continue
        a = _to_ascent(board, raw, difficulty_map)
        if a:
            out.append(a)
    return out
