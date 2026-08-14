"""Helpers for the golden-fixture contract tests.

The fixtures under ``<repo>/fixtures/*.json`` are shared verbatim with the TypeScript suite so both
parsers are held to the same normalized output. Each fixture holds the raw backend response and the
expected list of normalized ascents (camelCase, public fields only — ``raw`` is an escape hatch and
is intentionally out of the golden comparison).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"

# The normalized public fields compared across languages, in the shared camelCase form.
_BOOL_FIELDS = ("isBenchmark", "isMirror", "isRepeat")


def load_fixture(name: str) -> Dict[str, Any]:
    with (FIXTURES_DIR / f"{name}.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def normalize(ascent) -> Dict[str, Any]:
    """Project a Python ``Ascent`` onto the shared camelCase contract shape.

    ``None`` stays ``None`` (JSON ``null``); the three boolean flags are coerced to real booleans so
    a defaulted ``False`` and TypeScript's ``undefined`` compare equal.
    """
    d = ascent.to_dict()
    out = {
        "board": d["board"],
        "climbName": d.get("climb_name"),
        "date": d.get("date"),
        "grade": d.get("grade"),
        "userGrade": d.get("user_grade"),
        "vGrade": d.get("v_grade"),
        "tries": d.get("tries"),
        "angle": d.get("angle"),
        "isBenchmark": bool(d.get("is_benchmark")),
        "isMirror": bool(d.get("is_mirror")),
        "isRepeat": bool(d.get("is_repeat")),
        "comment": d.get("comment"),
    }
    return out


def normalize_all(ascents) -> List[Dict[str, Any]]:
    return [normalize(a) for a in ascents]
