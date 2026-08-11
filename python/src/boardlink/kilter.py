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
# (OIDC + PKCE); the logbook syncs over PowerSync; grades come from the portal REST API.
IDP = "https://idp.kiltergrips.com"
API = "https://portal.kiltergrips.com"
SYNC = "https://sync1.kiltergrips.com"
_REALM = "kilter"
_CLIENT = "kilter"
_REDIRECT = "com.kiltergrips:/oauthredirect"
_UA = "Dart/3.10 (dart:io)"
_MAX_ENRICHED_CLIMBS = 500


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


# Requests a full sync (after "0") and collects rows until the initial checkpoint completes; the
# connection would otherwise stay open for live updates.
def kilter_powersync_pull(access_token: str) -> dict:
    body = {
        "buckets": [
            {"name": "global[]", "after": "0"},
            {"name": "global_climbs[]", "after": "0"},
            {"name": "global_gyms[]", "after": "0"},
        ],
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
            if "checkpoint_complete" in msg or "checkpoint_diff" in msg:
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


def _find_table(tables: dict, *hints: str) -> Optional[dict]:
    names = list(tables)
    for hint in hints:
        for name in names:
            if name.lower() == hint:
                return tables[name]
    for hint in hints:
        for name in names:
            if hint in name.lower():
                return tables[name]
    return None


def _to_int(v) -> Optional[int]:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def build_grade_map(tables: dict) -> dict:
    grades = _find_table(tables, "difficulty_grades", "grades") or {}
    out = {}
    for g in grades.values():
        gid = _to_int(g.get("difficulty_grade_id") or g.get("id"))
        if gid is None:
            continue
        label = g.get("boulder_difficulty") or g.get("v_scale") or g.get("font_scale") or ""
        out[gid] = {"grade": label, "v_grade": parse_v_grade(g.get("v_scale") or g.get("boulder_difficulty"))}
    return out


def aggregate_difficulty_grade_id(ratings: list) -> Optional[int]:
    ids = [_to_int(r.get("difficultyGradeId") or r.get("difficulty_grade_id")) for r in ratings]
    ids = [i for i in ids if i and i > 0]
    if not ids:
        return None
    return round(sum(ids) / len(ids))


def _normalize_date(s: str) -> str:
    return s if "T" in s else s.replace(" ", "T", 1)


def _log_date(log: dict):
    return log.get("created_at") or log.get("createdAt") or log.get("climbed_at") or log.get("date")


def _climb_uuid(log: dict) -> str:
    return log.get("climb_uuid") or log.get("climbUuid") or log.get("climb_id") or ""


# Builds ascents from the logs table, keeping only sends. The catalog isn't synced, so grades are
# resolved separately (see connect_kilter); a climbs table is used for the name only if present.
def kilter_tables_to_ascents(tables: dict, grade_map: Optional[dict] = None) -> list:
    logs = _find_table(tables, "logs", "log", "ascents", "user_logs")
    if not logs:
        return []
    climbs = _find_table(tables, "climbs", "global_climbs", "climb") or {}
    grades = grade_map if grade_map is not None else build_grade_map(tables)

    out = []
    for log in logs.values():
        if _to_int(log.get("topped")) == 0:
            continue
        date = _log_date(log)
        if not date:
            continue
        climb = climbs.get(_climb_uuid(log)) or {}
        info = None
        diff = _to_int(climb.get("officialKilterDifficulty") or climb.get("currentDifficultyId") or climb.get("difficulty_grade_id"))
        if diff is not None:
            info = grades.get(diff)
        out.append(Ascent(
            board="kilter",
            climb_name=climb.get("name") or "",
            date=_normalize_date(str(date)),
            grade=info["grade"] if info else None,
            user_grade=info["grade"] if info else None,
            v_grade=info["v_grade"] if info else None,
            tries=_to_int(log.get("attempts") or log.get("tries")) or 1,
            angle=_to_int(log.get("angle")),
            is_mirror=bool(log.get("is_mirror") or log.get("isMirror")),
        ))
    return out


def _enrich_grades(ascents: list, logs: list, grade_map: dict, access_token: str) -> None:
    sends = [l for l in logs if _to_int(l.get("topped")) != 0 and _log_date(l)]
    cache: dict = {}

    def key(log):
        return f"{_climb_uuid(log)}@{_to_int(log.get('angle'))}"

    for log in sends:
        uuid_ = _climb_uuid(log)
        k = key(log)
        if not uuid_ or k in cache or len(cache) >= _MAX_ENRICHED_CLIMBS:
            continue
        angle = _to_int(log.get("angle"))
        try:
            r = requests.get(
                f"{API}/api/climb-rating/{uuid_}?angle={angle}",
                headers={"Authorization": f"Bearer {access_token}", "User-Agent": _UA, "Accept": "application/json"},
                timeout=30,
            )
            ratings = r.json() if r.ok else []
            gid = aggregate_difficulty_grade_id(ratings if isinstance(ratings, list) else [])
            cache[k] = grade_map.get(gid) if gid is not None else None
        except (requests.RequestException, ValueError):
            cache[k] = None

    for log, ascent in zip(sends, ascents):
        info = cache.get(key(log))
        if info:
            ascent.grade = info["grade"]
            ascent.user_grade = info["grade"]
            ascent.v_grade = info["v_grade"]


def connect_kilter(username: Optional[str] = None, password: Optional[str] = None, *, token: Optional[str] = None, resolve_grades: bool = True) -> ConnectResult:
    access_token, refresh_token = kilter_refresh(token) if token else kilter_login(username, password)
    tables = kilter_powersync_pull(access_token)
    grade_map = build_grade_map(tables)
    ascents = kilter_tables_to_ascents(tables, grade_map)
    if resolve_grades:
        logs = list((_find_table(tables, "logs", "log", "ascents", "user_logs") or {}).values())
        _enrich_grades(ascents, logs, grade_map, access_token)
    return ConnectResult("kilter", refresh_token, ascents)
