"""
Public API: connect_kilter / connect_tension / connect_moonboard / connect_board.

Each logs in through boardlib (see `_backend.py`), then normalizes every raw logbook row into the
board-agnostic `Ascent` — the same contract the TypeScript SDK emits. `normalize_entry` is pure and
unit-tested without boardlib installed.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

from . import _backend
from .grades import parse_v_grade
from .types import Ascent, BoardError, BoardSystem, ConnectResult

_MOON_ANGLE = 40


def _first(entry: Dict[str, Any], *keys: str) -> Optional[Any]:
    """Return the first present, non-empty value among candidate keys (tolerates field renames)."""
    for k in keys:
        if k in entry and entry[k] not in (None, ""):
            return entry[k]
    return None


def _to_int(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def normalize_entry(board: BoardSystem, entry: Dict[str, Any]) -> Optional[Ascent]:
    """Map one raw boardlib logbook row into a normalized `Ascent`. None if it has no date."""
    date = _first(entry, "date", "climbed_at", "DateClimbed")
    if not date:
        return None
    grade = _first(entry, "displayed_grade", "grade", "Grade")
    user_grade = _first(entry, "logged_grade", "user_grade", "UserGrade") or grade
    angle = _to_int(_first(entry, "angle", "Angle"))
    if board == "moonboard" and angle is None:
        angle = _MOON_ANGLE
    return Ascent(
        board=board,
        climb_name=str(_first(entry, "climb_name", "name", "Name") or ""),
        date=str(date),
        grade=str(grade) if grade is not None else None,
        user_grade=str(user_grade) if user_grade is not None else None,
        v_grade=parse_v_grade(str(grade) if grade is not None else user_grade),
        tries=_to_int(_first(entry, "tries", "attempts", "NumberOfTries")),
        angle=angle,
        is_benchmark=bool(_first(entry, "is_benchmark", "IsBenchmark") or False),
        is_mirror=bool(_first(entry, "is_mirror") or False),
        is_repeat=bool(_first(entry, "is_repeat") or False),
        comment=(str(_first(entry, "comment", "Comment")).strip() or None)
        if _first(entry, "comment", "Comment")
        else None,
    )


def _normalize_all(board: BoardSystem, rows: Iterable[Dict[str, Any]]) -> list[Ascent]:
    out: list[Ascent] = []
    for row in rows:
        ascent = normalize_entry(board, row)
        if ascent is not None:
            out.append(ascent)
    return out


def _connect_via_backend(board: BoardSystem, username: str, password: str) -> ConnectResult:
    if not username or not password:
        raise BoardError("missing-credentials", "username and password required", board)
    try:
        if board == "moonboard":
            rows = _backend.moon_entries(username, password)
        else:
            rows = _backend.aurora_entries(board, username, password)
    except BoardError:
        raise
    except Exception as e:  # boardlib raises requests errors etc.
        msg = str(e).lower()
        if "401" in msg or "403" in msg or "credential" in msg or "unauthor" in msg:
            raise BoardError("bad-credentials", f"Incorrect {board} email or password.", board) from e
        raise BoardError("unreachable", f"could not reach {board}: {e}", board) from e
    # boardlib re-authenticates per call, so there is no reusable token to hand back.
    return ConnectResult(board=board, token="", ascents=_normalize_all(board, rows))


def connect_kilter(username: str, password: str) -> ConnectResult:
    """Connect to Kilter and return the normalized logbook."""
    return _connect_via_backend("kilter", username, password)


def connect_tension(username: str, password: str) -> ConnectResult:
    """Connect to Tension and return the normalized logbook."""
    return _connect_via_backend("tension", username, password)


def connect_moonboard(username: str, password: str) -> ConnectResult:
    """Connect to MoonBoard and return the normalized logbook."""
    return _connect_via_backend("moonboard", username, password)


def connect_board(board: BoardSystem, username: str, password: str) -> ConnectResult:
    """Dispatch to the right connector by board name."""
    if board not in ("kilter", "tension", "moonboard"):
        raise BoardError("unexpected-response", f"unknown board: {board}")
    return _connect_via_backend(board, username, password)
