import pytest
import requests

from boardlink import aurora, webnames
from boardlink.webnames import resolve_climb_names

# Minimal stand-in for a scraped climb page; the name lives in <title> and <h1>.
_PAGES = {
    "abc": "<html><head><title>Duroxmanie 2.0</title></head><body><h1>Duroxmanie 2.0</h1></body></html>",
    "esc": "<html><head><title>Rock &amp; Roll</title></head></html>",
    "h1only": "<html><head></head><body><h1>Only In H1</h1></body></html>",
}


class _FakeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


class _FakeSession:
    """Records every GET so a test can assert the network was (not) hit; serves _PAGES, else 404."""

    def __init__(self):
        self.calls = []

    def get(self, url, **kwargs):
        uuid = url.rsplit("/", 1)[-1]
        self.calls.append(uuid)
        page = _PAGES.get(uuid)
        return _FakeResponse(200, page) if page is not None else _FakeResponse(404)

    def close(self):
        pass


@pytest.fixture
def cache_path(tmp_path):
    return str(tmp_path / "tension-names.json")


def test_extracts_name_from_title(cache_path):
    session = _FakeSession()
    assert resolve_climb_names("tension", ["abc"], cache_path=cache_path, session=session) == {
        "abc": "Duroxmanie 2.0"
    }


def test_falls_back_to_h1(cache_path):
    session = _FakeSession()
    assert resolve_climb_names("tension", ["h1only"], cache_path=cache_path, session=session) == {
        "h1only": "Only In H1"
    }


def test_unescapes_html_entities(cache_path):
    session = _FakeSession()
    assert resolve_climb_names("tension", ["esc"], cache_path=cache_path, session=session) == {
        "esc": "Rock & Roll"
    }


def test_404_stays_blank_and_is_not_cached(cache_path):
    session = _FakeSession()
    assert resolve_climb_names("tension", ["gone"], cache_path=cache_path, session=session) == {}
    # A miss must not be cached: a later publish should be re-fetched, not remembered as blank.
    session2 = _FakeSession()
    resolve_climb_names("tension", ["gone"], cache_path=cache_path, session=session2)
    assert session2.calls == ["gone"]


def test_cache_hit_skips_the_network(cache_path):
    first = _FakeSession()
    resolve_climb_names("tension", ["abc"], cache_path=cache_path, session=first)
    assert first.calls == ["abc"]
    second = _FakeSession()
    assert resolve_climb_names("tension", ["abc"], cache_path=cache_path, session=second) == {
        "abc": "Duroxmanie 2.0"
    }
    assert second.calls == []  # served entirely from the persisted cache


def test_only_missing_uuids_are_fetched(cache_path):
    first = _FakeSession()
    resolve_climb_names("tension", ["abc"], cache_path=cache_path, session=first)
    second = _FakeSession()
    resolve_climb_names("tension", ["abc", "esc"], cache_path=cache_path, session=second)
    assert second.calls == ["esc"]  # "abc" is cached, only "esc" hits the network


def test_corrupt_cache_is_treated_as_empty(cache_path):
    with open(cache_path, "w", encoding="utf-8") as f:
        f.write("{not json")
    session = _FakeSession()
    assert resolve_climb_names("tension", ["abc"], cache_path=cache_path, session=session) == {
        "abc": "Duroxmanie 2.0"
    }


def test_uses_default_session_and_aurora_ua(cache_path, monkeypatch):
    seen = {}

    def fake_get(self, url, **kwargs):
        seen["ua"] = kwargs.get("headers", {}).get("User-Agent")
        return _FakeResponse(200, _PAGES["abc"])

    monkeypatch.setattr(requests.Session, "get", fake_get)
    assert resolve_climb_names("tension", ["abc"], cache_path=cache_path) == {"abc": "Duroxmanie 2.0"}
    assert seen["ua"] == aurora._AURORA_UA


def test_unknown_board_raises(cache_path):
    with pytest.raises(Exception):
        resolve_climb_names("moonboard", ["abc"], cache_path=cache_path)


def test_connect_tension_web_wiring(cache_path, monkeypatch):
    monkeypatch.setattr(
        aurora,
        "_sync",
        lambda *a, **k: {
            "ascents": [
                {"climbed_at": "2026-05-01 19:30:00", "difficulty": 23, "climb_uuid": "abc"},
                {"climbed_at": "2026-05-02 10:00:00", "difficulty": 20, "climb_uuid": "gone"},
            ]
        },
    )
    monkeypatch.setattr(
        webnames,
        "resolve_climb_names",
        lambda board, uuids, **k: {"abc": "Duroxmanie 2.0"},
    )
    result = aurora.connect_tension(token="tok", resolve_names="web")
    resolved = {a.raw["climb_uuid"]: a.climb_name for a in result.ascents}
    assert resolved == {"abc": "Duroxmanie 2.0", "gone": ""}
