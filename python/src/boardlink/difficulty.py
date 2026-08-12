from __future__ import annotations

from typing import Optional

from .grades import parse_v_grade

# The Aurora difficulty_grades reference table (ids 1-39). Both Aurora boards (Tension) and the new
# Kilter app report an integer "difficulty" that indexes this table; it is static shared data, so it
# is bundled here rather than synced. Neither board reliably returns it over its sync API.
#
# Compact source rows of (id, "font/V", french, yds). Font and V-scale are split from the label.
_ROWS = [
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


def _build() -> dict:
    out = {}
    for gid, label, french, yds in _ROWS:
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


# difficulty id -> the grade on every scale (label, font, v_scale, v_grade, french, yds).
DIFFICULTY_GRADES = _build()


def grade_for_difficulty(difficulty: Optional[float]) -> Optional[dict]:
    """Resolve an integer difficulty to its grade on every scale, or None if unknown.

    Aurora consensus difficulties can be fractional, so the id is rounded first.
    """
    if difficulty is None:
        return None
    return DIFFICULTY_GRADES.get(round(difficulty))
