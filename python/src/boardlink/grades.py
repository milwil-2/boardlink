from __future__ import annotations

import re
from typing import Optional

# Boards display the V-scale ("V5"), Font ("6C+", "7A"), or a compound "6C+/V5". Mirrors grades.ts.

_FONT_TO_V = {
    "4": 0, "5": 1, "5+": 2,
    "6A": 3, "6A+": 3, "6B": 4, "6B+": 4, "6C": 5, "6C+": 5,
    "7A": 6, "7A+": 7, "7B": 8, "7B+": 8, "7C": 9, "7C+": 10,
    "8A": 11, "8A+": 12, "8B": 13, "8B+": 14, "8C": 15, "8C+": 16,
}


def font_to_v(num: int, letter: Optional[str] = None, plus: Optional[str] = None) -> Optional[int]:
    key = f"{num}{letter or ''}{plus or ''}"
    return _FONT_TO_V.get(key) or _FONT_TO_V.get(f"{num}{letter or ''}") or _FONT_TO_V.get(str(num))


def parse_v_grade(grade: Optional[str]) -> Optional[int]:
    if not grade:
        return None
    g = grade.strip().upper()
    m = re.search(r"V(\d+)", g)
    if m:
        return int(m.group(1))
    f = re.match(r"^(\d+)([ABC])?(\+)?$", g)
    if f:
        return font_to_v(int(f.group(1)), f.group(2), f.group(3))
    return None
