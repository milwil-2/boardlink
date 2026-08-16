from __future__ import annotations

from typing import Optional

from .aurora import connect_tension
from .kilter import connect_kilter
from .types import BoardError, BoardSystem, ConnectResult

# MoonBoard's API was retired; the connector is temporarily removed. See
# https://github.com/milwil-2/boardlink/issues/1
_MOONBOARD_RETIRED = (
    "MoonBoard support is temporarily unavailable: its web API was decommissioned and the new app "
    "backend is gated by Apple App Attest. Track re-enablement at "
    "https://github.com/milwil-2/boardlink/issues/1"
)


def connect_board(
    board: BoardSystem,
    username: Optional[str] = None,
    password: Optional[str] = None,
    *,
    token: Optional[str] = None,
) -> ConnectResult:
    if board == "kilter":
        return connect_kilter(username, password, token=token)
    if board == "tension":
        return connect_tension(username, password, token=token)
    if board == "moonboard":
        raise BoardError("retired", _MOONBOARD_RETIRED, "moonboard")
    raise BoardError("unexpected-response", f"unknown board: {board}")
