import pytest

from boardlink import connect_board
from boardlink.types import BoardError


def test_moonboard_is_retired():
    # Support is temporarily removed pending the API migration tracked in issue #1; the dispatch must
    # fail fast with a `retired` code rather than attempt the decommissioned endpoints.
    with pytest.raises(BoardError) as exc:
        connect_board("moonboard", "u", "p")
    assert exc.value.code == "retired"
    assert exc.value.board == "moonboard"


def test_unknown_board_is_unexpected_response():
    with pytest.raises(BoardError) as exc:
        connect_board("verminboard", "u", "p")
    assert exc.value.code == "unexpected-response"
