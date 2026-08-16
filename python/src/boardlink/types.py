from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Literal, Optional

BoardSystem = Literal["kilter", "tension", "moonboard"]


# One normalized ascent. Matches the TypeScript Ascent contract, snake_cased.
@dataclass
class Ascent:
    board: BoardSystem
    climb_name: str
    date: str
    grade: Optional[str] = None
    user_grade: Optional[str] = None
    v_grade: Optional[int] = None
    tries: Optional[int] = None
    angle: Optional[int] = None
    is_benchmark: bool = False
    is_mirror: bool = False
    is_repeat: bool = False
    comment: Optional[str] = None
    # The untouched source record this ascent was mapped from; escape hatch for board-specific
    # fields the normalized shape doesn't cover.
    raw: Optional[Dict[str, Any]] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ConnectResult:
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
    # The board's own API was decommissioned, so this connector cannot function regardless of
    # credentials. Nothing the caller can do until it is rewritten against the new backend.
    "retired",
]


class BoardError(Exception):
    def __init__(self, code: BoardErrorCode, message: str, board: Optional[BoardSystem] = None):
        super().__init__(message)
        self.code: BoardErrorCode = code
        self.board = board
