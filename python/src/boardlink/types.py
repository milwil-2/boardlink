"""boardlink's public data contract — mirrors the TypeScript `@boardlink/core` types."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import List, Literal, Optional

BoardSystem = Literal["kilter", "tension", "moonboard"]


@dataclass
class Ascent:
    """One normalized ascent, board-agnostic (same shape as the TS `Ascent`)."""

    board: BoardSystem
    climb_name: str
    date: str  # ISO date or datetime
    grade: Optional[str] = None  # displayed/consensus, e.g. "6C+/V5" or "7A+"
    user_grade: Optional[str] = None  # user-logged, when it differs
    v_grade: Optional[int] = None  # parsed V-scale integer
    tries: Optional[int] = None  # 1 == flash
    angle: Optional[int] = None  # Kilter/Tension adjustable; MoonBoard fixed 40
    is_benchmark: bool = False
    is_mirror: bool = False
    is_repeat: bool = False
    comment: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ConnectResult:
    """A successful connect/sync: a reusable token (may be empty for MoonBoard) + the logbook."""

    board: BoardSystem
    token: str
    ascents: List[Ascent] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"board": self.board, "token": self.token, "ascents": [a.to_dict() for a in self.ascents]}


BoardErrorCode = Literal[
    "missing-credentials",
    "bad-credentials",
    "session-expired",
    "unreachable",
    "unexpected-response",
]


class BoardError(Exception):
    """Typed error for all board failures, so callers can branch on `.code`."""

    def __init__(self, code: BoardErrorCode, message: str, board: Optional[BoardSystem] = None):
        super().__init__(message)
        self.code: BoardErrorCode = code
        self.board = board
