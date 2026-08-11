from __future__ import annotations

from typing import Optional

from .aurora import connect_tension
from .kilter import connect_kilter
from .moon import connect_moonboard
from .types import BoardError, BoardSystem, ConnectResult


def connect_board(board: BoardSystem, username: Optional[str] = None, password: Optional[str] = None, *, token: Optional[str] = None) -> ConnectResult:
    if board == "kilter":
        return connect_kilter(username, password, token=token)
    if board == "tension":
        return connect_tension(username, password, token=token)
    if board == "moonboard":
        return connect_moonboard(username, password, token=token)
    raise BoardError("unexpected-response", f"unknown board: {board}")
