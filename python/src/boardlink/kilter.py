from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import uuid
from typing import Optional
from urllib.parse import parse_qs, urlparse

import requests

from .grades import parse_v_grade
from .types import Ascent, BoardError, ConnectResult

# The Kilter app's backend since it left Aurora in 2025. See docs/kilter-new-api.md. Auth is Keycloak
# (OIDC + PKCE); the logbook comes from the portal REST API (GET /api/logs), enriched by the server
# with climb names and grades.
IDP = "https://idp.kiltergrips.com"
API = "https://portal.kiltergrips.com"
SYNC = "https://sync1.kiltergrips.com"
_REALM = "kilter"
_CLIENT = "kilter"
_REDIRECT = "com.kiltergrips:/oauthredirect"
_UA = "Dart/3.10 (dart:io)"

# Kilter's static difficulty_grades reference table (ids 1-39), compact source rows of
# (id, "font/V", french, yds). Bundled rather than fetched: it changes about as often as the grade
# scales themselves. Font and V-scale are split from the compound label below.
_KILTER_GRADE_ROWS = [
    (1, "1A/V0", "2b", "5.1"), (2, "1B/V0", "2c", "5.2"), (3, "1C/V0", "3a", "5.3"),
    (4, "2A/V0", "3b", "5.3"), (5, "2B/V0", "3c", "5.4"), (6, "2C/V0", "4a", "5.5"),
    (7, "3A/V0", "4b", "5.6"), (8, "3B/V0", "4c", "5.7"), (9, "3C/V0", "5a", "5.8"),
    (10, "4A/V0", "5b", "5.9"), (11, "4B/V0", "5c", "5.10a"), (12, "4C/V0", "6a", "5.10b"),
    (13, "5A/V1", "6a+", "5.10c"), (14, "5B/V1", "6b", "5.10d"), (15, "5C/V2", "6b+", "5.11a"),
    (16, "6A/V3", "6c", "5.11b"), (17, "6A+/V3", "6c+", "5.11c"), (18, "6B/V4", "7a", "5.11d"),
    (19, "6B+/V4", "7a+", "5.12a"), (20, "6C/V5", "7b", "5.12b"), (21, "6C+/V5", "7b+", "5.12c"),
    (22, "7A/V6", "7c", "5.12d"), (23, "7A+/V7", "7c+", "5.13a"), (24, "7B/V8", "8a", "5.13b"),
    (25, "7B+/V8", "8a+", "5.13c"), (26, "7C/V9", "8b", "5.13d"), (27, "7C+/V10", "8b+", "5.14a"),
    (28, "8A/V11", "8c", "5.14b"), (29, "8A+/V12", "8c+", "5.14c"), (30, "8B/V13", "9a", "5.14d"),
    (31, "8B+/V14", "9a+", "5.15a"), (32, "8C/V15", "9b", "5.15b"), (33, "8C+/V16", "9b+", "5.15c"),
    (34, "9A/V17", "9c", "5.15d"), (35, "9A+/V18", "9c+", "5.16a"), (36, "9B/V19", "10a", "5.16b"),
    (37, "9B+/V20", "10a+", "5.16c"), (38, "9C/V21", "10b", "5.16d"), (39, "9C+/V22", "10b+", "5.17a"),
]


def _build_difficulty_grades() -> dict:
    out = {}
    for gid, label, french, yds in _KILTER_GRADE_ROWS:
        font, v_scale = label.split("/")
        out[gid] = {
            "label": label,
            "font": font,
            "v_scale": v_scale,
            "v_grade": parse_v_grade(v_scale),
            "french": french,
            "yds": yds,
        }
    return out


# difficulty_grade_id -> the grade on every scale (label, font, v_scale, v_grade, french, yds), so
# callers can pick whichever grading system they want.
KILTER_DIFFICULTY_GRADES = _build_difficulty_grades()


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _decode_entities(s: str) -> str:
    return s.replace("&amp;", "&").replace("&#x2F;", "/").replace("&quot;", '"').replace("&#39;", "'")


def kilter_login(username: str, password: str) -> tuple:
    if not username or not password:
        raise BoardError("missing-credentials", "username and password required", "kilter")
    session = requests.Session()
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    params = {
        "response_type": "code",
        "client_id": _CLIENT,
        "redirect_uri": _REDIRECT,
        "scope": "openid offline_access",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": _b64url(secrets.token_bytes(16)),
        "nonce": _b64url(secrets.token_bytes(16)),
    }

    try:
        page = session.get(
            f"{IDP}/realms/{_REALM}/protocol/openid-connect/auth",
            params=params,
            headers={"User-Agent": _UA},
            allow_redirects=False,
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach Kilter login", "kilter") from e

    action = re.search(r'action=["\']([^"\']+login-actions/authenticate[^"\']*)["\']', page.text, re.I)
    if not action:
        raise BoardError("unexpected-response", "Kilter login form changed (no action URL)", "kilter")

    try:
        r = session.post(
            _decode_entities(action.group(1)),
            data={"username": username, "password": password},
            headers={"User-Agent": _UA, "Content-Type": "application/x-www-form-urlencoded"},
            allow_redirects=False,
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach Kilter login", "kilter") from e

    # Success is a 302 back to the app's redirect URI; a re-rendered form means bad credentials.
    location = r.headers.get("location", "")
    if not (300 <= r.status_code < 400) or not location.startswith(_REDIRECT):
        raise BoardError("bad-credentials", "Incorrect Kilter email or password.", "kilter")
    code = parse_qs(urlparse(location.replace(_REDIRECT, "https://x")).query).get("code", [None])[0]
    if not code:
        raise BoardError("unexpected-response", "no authorization code returned", "kilter")

    return _token_request({
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": _REDIRECT,
        "client_id": _CLIENT,
    })


def kilter_refresh(refresh_token: str) -> tuple:
    return _token_request({"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": _CLIENT})


def _token_request(data: dict) -> tuple:
    try:
        r = requests.post(
            f"{IDP}/realms/{_REALM}/protocol/openid-connect/token",
            data=data,
            headers={"User-Agent": _UA, "Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach Kilter token endpoint", "kilter") from e
    if r.status_code in (400, 401):
        refreshing = data["grant_type"] == "refresh_token"
        raise BoardError(
            "session-expired" if refreshing else "bad-credentials",
            "Kilter session expired" if refreshing else "Kilter login rejected",
            "kilter",
        )
    if not r.ok:
        raise BoardError("unexpected-response", f"token request failed ({r.status_code})", "kilter")
    body = r.json()
    if not body.get("access_token") or not body.get("refresh_token"):
        raise BoardError("unexpected-response", "token response missing tokens", "kilter")
    return body["access_token"], body["refresh_token"]


def kilter_fetch_logbook(access_token: str) -> list:
    """Fetch the authenticated user's logbook (GET /api/logs).

    The bearer token identifies the user; there is no id in the path (the /api/logs/{id} form is for
    viewing another user's public logs). The server joins the climb name and current difficulty in.
    """
    try:
        r = requests.get(
            f"{API}/api/logs",
            headers={"Authorization": f"Bearer {access_token}", "User-Agent": _UA, "Accept": "application/json"},
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach Kilter logbook", "kilter") from e
    if r.status_code == 401:
        raise BoardError("session-expired", "Kilter session expired", "kilter")
    if not r.ok:
        raise BoardError("unexpected-response", f"logbook request failed ({r.status_code})", "kilter")
    try:
        body = r.json()
    except ValueError:
        return []
    return body if isinstance(body, list) else []


def kilter_grade(difficulty_id: Optional[int]) -> Optional[dict]:
    """Resolve a difficulty_grade_id to its grade on every scale, or None if unknown."""
    if difficulty_id is None:
        return None
    return KILTER_DIFFICULTY_GRADES.get(difficulty_id)


def kilter_log_to_ascent(log: dict) -> Ascent:
    """Map one GET /api/logs entry to a normalized ascent.

    The consensus grade fills ``grade``; the user's own suggestion, when present and different, fills
    ``user_grade``.
    """
    consensus = kilter_grade(log.get("currentDifficultyId"))
    grade = consensus["label"] if consensus else None
    own_id = (log.get("climbRating") or {}).get("difficultyGradeId")
    own = KILTER_DIFFICULTY_GRADES.get(own_id) if own_id is not None else None
    user_grade = own["label"] if own and own["label"] != grade else None
    attempts = log.get("attempts")
    angle = log.get("angle")
    return Ascent(
        board="kilter",
        climb_name=log.get("climbName") or "",
        date=log.get("createdAt") or "",
        grade=grade,
        user_grade=user_grade,
        v_grade=consensus["v_grade"] if consensus else None,
        tries=attempts if isinstance(attempts, int) else (1 if log.get("flashed") else None),
        angle=angle if isinstance(angle, int) else None,
        raw=log,
    )


def connect_kilter(username: Optional[str] = None, password: Optional[str] = None, *, token: Optional[str] = None) -> ConnectResult:
    """Pass credentials or a stored refresh token. Returns the (rotated) refresh token and the
    normalized logbook. Only topped ascents are included; raw attempt logs are skipped.
    """
    access_token, refresh_token = kilter_refresh(token) if token else kilter_login(username, password)
    logs = kilter_fetch_logbook(access_token)
    ascents = [kilter_log_to_ascent(log) for log in logs if log.get("topped") is not False]
    return ConnectResult("kilter", refresh_token, ascents)


# --- Advanced: raw board data over PowerSync ---------------------------------------------------
# The logbook above needs only the REST API. The app also streams the full board dataset (holds,
# walls, gyms, difficulty grades, hold geometry) over PowerSync; kilter_powersync_pull exposes that
# raw, for callers that want to render climbs or inspect the catalog. It is not needed for ascents.


def kilter_powersync_pull(access_token: str) -> dict:
    """Request a full sync (after "0") and collect rows until the initial checkpoint completes; the
    connection would otherwise stay open for live updates.
    """
    body = {
        "buckets": [{"name": "global[]", "after": "0"}],
        "include_checksum": True,
        "raw_data": True,
        "binary_data": False,
        "client_id": str(uuid.uuid4()),
        "parameters": {},
        "streams": {"include_defaults": True, "subscriptions": []},
        "app_metadata": {},
    }
    try:
        r = requests.post(
            f"{SYNC}/sync/stream",
            json=body,
            headers={"Accept": "application/x-ndjson", "Authorization": f"Bearer {access_token}", "User-Agent": "powersync-dart-core/1.7.0"},
            stream=True,
            timeout=60,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach Kilter sync", "kilter") from e
    if r.status_code == 401:
        raise BoardError("session-expired", "Kilter sync unauthorized", "kilter")
    if not r.ok:
        raise BoardError("unexpected-response", f"sync failed ({r.status_code})", "kilter")

    tables: dict = {}
    try:
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("data"):
                _apply_bucket_data(tables, msg["data"])
            if "checkpoint_complete" in msg:
                break
    finally:
        r.close()
    return tables


def _apply_bucket_data(tables: dict, sync_data: dict) -> None:
    for op in sync_data.get("data") or []:
        object_type = op.get("object_type")
        object_id = op.get("object_id")
        if not object_type or not object_id:
            continue
        table = tables.setdefault(object_type, {})
        if op.get("op") == "REMOVE":
            table.pop(object_id, None)
            continue
        raw = op.get("data")
        if isinstance(raw, str):
            try:
                table[object_id] = json.loads(raw)
            except ValueError:
                table[object_id] = {"_raw": raw}
        elif isinstance(raw, dict):
            table[object_id] = raw
        else:
            table[object_id] = {}
