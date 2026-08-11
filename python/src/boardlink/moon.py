from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlencode

import requests

from .grades import parse_v_grade
from .types import Ascent, BoardError, ConnectResult

# MoonBoard uses a cookie/CSRF session login, then a paginated logbook filtered by board setup id.
MOON_HOST = "https://moonboard.com"
MOON_BOARD_IDS = {
    "MoonBoard 2016": 1,
    "MoonBoard Masters 2017": 15,
    "MoonBoard Masters 2019": 17,
    "MoonBoard 2020": 19,
    "MoonBoard 2024": 21,
}
_ANGLE = 40
_PAGE = 40
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

_ATTEMPTS = {"Flashed": 1, "2nd try": 2, "3rd try": 3, "more than 3 tries": 4, "Project": None}
_MONTHS = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}


def parse_moon_tries(label: Optional[str]) -> Optional[int]:
    if not label:
        return 1
    return _ATTEMPTS[label] if label in _ATTEMPTS else 1


def parse_moon_date(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$", s.strip())
    if not m:
        return None
    month = _MONTHS.get(m.group(2).lower())
    if not month:
        return None
    return f"{m.group(3)}-{month}-{int(m.group(1)):02d}"


def extract_input_value(html: str, name: str) -> Optional[str]:
    m = re.search(rf'name=["\']{name}["\'][^>]*?value=["\']([^"\']+)["\']', html, re.I)
    if not m:
        m = re.search(rf'value=["\']([^"\']+)["\'][^>]*?name=["\']{name}["\']', html, re.I)
    return m.group(1) if m else None


def moon_entry_to_ascent(entry: dict) -> Optional[Ascent]:
    date = parse_moon_date(entry.get("DateClimbedAsString"))
    if not date:
        return None
    tries = parse_moon_tries(entry.get("NumberOfTries"))
    if tries is None:  # project, not a send
        return None
    p = entry.get("Problem") or {}
    grade = p.get("Grade") or None
    user_grade = p.get("UserGrade") or p.get("Grade") or None
    return Ascent(
        board="moonboard",
        climb_name=p.get("Name") or "",
        date=date,
        grade=grade,
        user_grade=user_grade,
        v_grade=parse_v_grade(grade or user_grade),
        tries=tries,
        angle=_ANGLE,
        is_benchmark=bool(p.get("IsBenchmark")),
        comment=(entry.get("Comment") or "").strip() or None,
    )


def moon_entries_to_ascents(entries: list) -> list:
    out = []
    for e in entries:
        a = moon_entry_to_ascent(e)
        if a:
            out.append(a)
    return out


def connect_moonboard(username: Optional[str] = None, password: Optional[str] = None, *, token: Optional[str] = None) -> ConnectResult:
    session = requests.Session()
    session.headers["User-Agent"] = _UA
    if token:
        for part in token.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                session.cookies.set(k.strip(), v.strip())
    else:
        _login(session, username, password)

    entries = _fetch_all(session)
    if entries is None:
        raise BoardError("session-expired", "session expired", "moonboard")
    return ConnectResult("moonboard", _cookie_str(session), moon_entries_to_ascents(entries))


def _login(session: requests.Session, username, password) -> None:
    if not username or not password:
        raise BoardError("missing-credentials", "username and password required", "moonboard")
    try:
        page = session.get(f"{MOON_HOST}/account/login", timeout=30)
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach MoonBoard", "moonboard") from e
    if not page.ok:
        raise BoardError("unexpected-response", "could not load login page", "moonboard")
    token = extract_input_value(page.text, "__RequestVerificationToken")
    form_key = extract_input_value(page.text, "form_key") or ""
    if not token:
        raise BoardError("unexpected-response", "login form changed (no CSRF token)", "moonboard")

    try:
        r = session.post(
            f"{MOON_HOST}/Account/login",
            data={"Login.Username": username, "Login.Password": password, "__RequestVerificationToken": token, "form_key": form_key},
            headers={"Referer": f"{MOON_HOST}/account/login"},
            allow_redirects=False,
            timeout=30,
        )
    except requests.RequestException as e:
        raise BoardError("unreachable", "could not reach MoonBoard", "moonboard") from e

    redirected = 300 <= r.status_code < 400
    has_auth = any(re.search(r"auth|aspnet|moon", c.name, re.I) for c in session.cookies)
    if not redirected and not has_auth:
        raise BoardError("bad-credentials", "Incorrect MoonBoard email or password.", "moonboard")


def _logbook_body(setup_id: int, page: int, page_size: int = _PAGE) -> str:
    return urlencode({"sort": "", "page": page, "pageSize": page_size, "group": "", "filter": f"setupId~eq~'{setup_id}'"})


def _fetch_all(session: requests.Session) -> Optional[list]:
    entries: list = []
    saw_valid = False
    headers = {"X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded"}

    for setup_id in MOON_BOARD_IDS.values():
        for page in range(1, 26):
            r = session.post(f"{MOON_HOST}/Logbook/GetLogbook", data=_logbook_body(setup_id, page), headers=headers, timeout=30)
            if r.status_code in (401, 403):
                return entries if saw_valid else None
            if not r.ok:
                break
            try:
                data = r.json()
            except ValueError:
                return entries if saw_valid else None
            saw_valid = True
            rows = data.get("Data") or []
            entries.extend(_expand_rows(session, rows, headers))
            total = data.get("Total", len(rows))
            if not rows or total <= _PAGE * page:
                break
    return entries


def _expand_rows(session: requests.Session, rows: list, headers: dict) -> list:
    out = []
    for row in rows:
        if row.get("Problem"):
            out.append(row)
        elif row.get("Id") is not None:
            r = session.post(f"{MOON_HOST}/Logbook/GetLogbookEntries/{row['Id']}", data=_logbook_body(0, 1), headers=headers, timeout=30)
            if not r.ok:
                continue
            try:
                out.extend(r.json().get("Data") or [])
            except ValueError:
                pass
    return out


def _cookie_str(session: requests.Session) -> str:
    return "; ".join(f"{c.name}={c.value}" for c in session.cookies)
