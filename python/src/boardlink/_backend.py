"""
Isolation layer for the community `boardlib` package.

boardlib's Python API surface has shifted across releases, so EVERY version-specific call lives here
— this is the one file to adjust if your installed boardlib exposes different names. The normalization
in `client.py` and the grade parsing in `grades.py` never need to change.

We target boardlib's high-level `logbook_entries(board, username, password)` generator, which already
merges the shared grade database and yields dicts shaped like the CLI's CSV rows:
    {board, angle, climb_name, date, logged_grade, displayed_grade, tries, is_mirror, comment, ...}
"""

from __future__ import annotations

from typing import Any, Dict, Iterable

from .types import BoardError

# boardlib's board identifier for MoonBoard differs from ours.
_MOON_BOARD_ARG = "moon"


def _require_boardlib():
    try:
        import boardlib.api.aurora as aurora  # type: ignore
        import boardlib.api.moon as moon  # type: ignore
    except ImportError as e:  # pragma: no cover - env dependent
        raise BoardError(
            "unexpected-response",
            "boardlib is not installed. Run `pip install boardlib` (a boardlink dependency).",
        ) from e
    return aurora, moon


def aurora_entries(board: str, username: str, password: str) -> Iterable[Dict[str, Any]]:
    """Yield raw logbook dicts for an Aurora board (kilter/tension) via boardlib."""
    aurora, _ = _require_boardlib()
    try:
        return aurora.logbook_entries(board, username, password)
    except AttributeError as e:  # pragma: no cover - version dependent
        raise BoardError(
            "unexpected-response",
            "This boardlib version has no aurora.logbook_entries; adjust boardlink/_backend.py.",
            board,  # type: ignore[arg-type]
        ) from e


def moon_entries(username: str, password: str) -> Iterable[Dict[str, Any]]:
    """Yield raw logbook dicts for MoonBoard via boardlib."""
    _, moon = _require_boardlib()
    try:
        return moon.logbook_entries(_MOON_BOARD_ARG, username, password)
    except AttributeError as e:  # pragma: no cover - version dependent
        raise BoardError(
            "unexpected-response",
            "This boardlib version has no moon.logbook_entries; adjust boardlink/_backend.py.",
            "moonboard",
        ) from e
