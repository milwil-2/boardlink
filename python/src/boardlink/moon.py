from __future__ import annotations

import re
from typing import Optional

from .grades import parse_v_grade
from .types import Ascent, BoardError, ConnectResult

# MoonBoard's own web logbook API (a cookie/CSRF session) has been decommissioned; its live connector
# is retired below. The pure mappers here are I/O-free and still guarded by the golden-fixture
# contract test, so they stay. Board configurations kept for reference by the mappers.
MOON_BOARD_IDS = {
    "MoonBoard 2016": 1,
    "MoonBoard Masters 2017": 15,
    "MoonBoard Masters 2019": 17,
    "MoonBoard 2020": 19,
    "MoonBoard 2024": 21,
}
_ANGLE = 40

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
        raw=entry,
    )


def moon_entries_to_ascents(entries: list) -> list:
    out = []
    for e in entries:
        a = moon_entry_to_ascent(e)
        if a:
            out.append(a)
    return out


# MoonBoard support is temporarily removed. Its web logbook API (the cookie/CSRF flow the network
# code here used to drive) was decommissioned, and the Moon Climbing app's replacement backend is
# gated by Firebase App Check / Apple App Attest, which a third-party client cannot satisfy. The
# pure mappers above are kept because the golden-fixture contract test still exercises them.
# See: https://github.com/milwil-2/boardlink/issues/1
_RETIRED_MESSAGE = (
    "MoonBoard support is temporarily unavailable: its web API was decommissioned and the new app "
    "backend is gated by Apple App Attest. Track re-enablement at "
    "https://github.com/milwil-2/boardlink/issues/1"
)


def connect_moonboard(
    username: Optional[str] = None,
    password: Optional[str] = None,
    *,
    token: Optional[str] = None,
) -> ConnectResult:
    raise BoardError("retired", _RETIRED_MESSAGE, "moonboard")
