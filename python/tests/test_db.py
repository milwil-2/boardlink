import sqlite3

import pytest

from boardlink import aurora
from boardlink.db import climb_frames, climb_name, climb_names


def _seed(conn):
    conn.execute("CREATE TABLE climbs (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, frames TEXT NOT NULL)")
    conn.executemany(
        "INSERT INTO climbs (uuid, name, frames) VALUES (?, ?, ?)",
        [("abc", "Crimpy", "p1r12"), ("def", "Slopey", "p2r13")],
    )
    conn.commit()


@pytest.fixture
def mem_db():
    conn = sqlite3.connect(":memory:")
    _seed(conn)
    yield conn
    conn.close()


@pytest.fixture
def file_db(tmp_path):
    path = tmp_path / "tension.sqlite3"
    conn = sqlite3.connect(str(path))
    _seed(conn)
    conn.close()
    return str(path)


def test_climb_names_batch_resolves_known_uuids(mem_db):
    assert climb_names(mem_db, ["abc", "def", "missing"]) == {"abc": "Crimpy", "def": "Slopey"}


def test_climb_names_dedupes_and_drops_blanks(mem_db):
    assert climb_names(mem_db, ["abc", "abc", "", None]) == {"abc": "Crimpy"}


def test_climb_name_single(mem_db):
    assert climb_name(mem_db, "def") == "Slopey"
    assert climb_name(mem_db, "nope") is None


def test_climb_frames(mem_db):
    assert climb_frames(mem_db, ["abc"]) == {"abc": "p1r12"}


def test_climb_names_accepts_a_file_path(file_db):
    assert climb_names(file_db, ["abc"]) == {"abc": "Crimpy"}


def test_connect_tension_fills_names_from_db(file_db, monkeypatch):
    monkeypatch.setattr(
        aurora,
        "_sync",
        lambda *a, **k: {
            "ascents": [
                {"climbed_at": "2026-05-01 19:30:00", "difficulty": 23, "climb_uuid": "abc"},
                {"climbed_at": "2026-05-02 10:00:00", "difficulty": 20, "climb_uuid": "missing"},
            ]
        },
    )
    result = aurora.connect_tension(token="tok", db_path=file_db)
    resolved = {a.raw["climb_uuid"]: a.climb_name for a in result.ascents}
    assert resolved == {"abc": "Crimpy", "missing": ""}


def test_connect_tension_leaves_names_blank_without_opt_in(tmp_path, monkeypatch):
    # No db_path, resolve_names default False, and no cached catalog -> names stay blank, no download.
    monkeypatch.setattr(aurora, "default_db_path", lambda board: str(tmp_path / "absent.sqlite3"))
    monkeypatch.setattr(
        aurora,
        "_sync",
        lambda *a, **k: {"ascents": [{"climbed_at": "2026-05-01 19:30:00", "difficulty": 23, "climb_uuid": "abc"}]},
    )
    result = aurora.connect_tension(token="tok")
    assert result.ascents[0].climb_name == ""
