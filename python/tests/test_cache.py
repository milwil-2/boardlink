import json
from typing import Dict, List

import pytest

from boardlink import db
from boardlink.cache import FileNameCache, NameCache
from boardlink.webnames import resolve_climb_names

_PAGES = {
    "abc": "<html><head><title>Duroxmanie 2.0</title></head></html>",
    "esc": "<html><head><title>Rock &amp; Roll</title></head></html>",
}


class _FakeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


class _FakeSession:
    def __init__(self):
        self.calls = []

    def get(self, url, **kwargs):
        uuid = url.rsplit("/", 1)[-1]
        self.calls.append(uuid)
        page = _PAGES.get(uuid)
        return _FakeResponse(200, page) if page is not None else _FakeResponse(404)

    def close(self):
        pass


class _MemoryNameCache:
    """In-memory NameCache; records batch calls so a test can assert the protocol is exercised."""

    def __init__(self, seed=None):
        self.store: Dict[str, str] = dict(seed or {})
        self.get_calls: List[List[str]] = []
        self.set_calls: List[Dict[str, str]] = []

    def get_many(self, keys: List[str]) -> Dict[str, str]:
        self.get_calls.append(list(keys))
        return {k: self.store[k] for k in keys if k in self.store}

    def set_many(self, mapping: Dict[str, str]) -> None:
        self.set_calls.append(dict(mapping))
        self.store.update(mapping)


def test_memory_cache_satisfies_protocol():
    assert isinstance(_MemoryNameCache(), NameCache)
    assert isinstance(FileNameCache("x"), NameCache)


def test_injected_cache_uses_get_many_and_set_many():
    cache = _MemoryNameCache()
    session = _FakeSession()
    result = resolve_climb_names("tension", ["abc"], cache=cache, session=session)
    assert result == {"abc": "Duroxmanie 2.0"}
    assert cache.get_calls == [["abc"]]
    assert cache.set_calls == [{"abc": "Duroxmanie 2.0"}]


def test_cache_hit_skips_the_network():
    cache = _MemoryNameCache(seed={"abc": "Duroxmanie 2.0"})
    session = _FakeSession()
    result = resolve_climb_names("tension", ["abc"], cache=cache, session=session)
    assert result == {"abc": "Duroxmanie 2.0"}
    assert session.calls == []  # entirely served from cache
    assert cache.set_calls == []  # nothing new to persist


def test_only_missing_uuids_are_fetched():
    cache = _MemoryNameCache(seed={"abc": "Duroxmanie 2.0"})
    session = _FakeSession()
    result = resolve_climb_names("tension", ["abc", "esc"], cache=cache, session=session)
    assert result == {"abc": "Duroxmanie 2.0", "esc": "Rock & Roll"}
    assert session.calls == ["esc"]  # "abc" cached; only "esc" hits the network
    assert cache.set_calls == [{"esc": "Rock & Roll"}]


def test_injected_cache_bypasses_the_file(tmp_path, monkeypatch):
    # An injected cache must be the only store touched: no default name file is created.
    names_file = tmp_path / "tension-names.json"
    monkeypatch.setattr(db, "_cache_dir", lambda: str(tmp_path))
    cache = _MemoryNameCache()
    session = _FakeSession()
    resolve_climb_names("tension", ["abc"], cache=cache, session=session)
    assert not names_file.exists()


def test_cache_precedence_over_cache_path(tmp_path):
    # cache= wins over cache_path=: the path file is never written when a cache is supplied.
    cache = _MemoryNameCache()
    path = tmp_path / "unused.json"
    session = _FakeSession()
    resolve_climb_names("tension", ["abc"], cache=cache, cache_path=str(path), session=session)
    assert cache.store == {"abc": "Duroxmanie 2.0"}
    assert not path.exists()


# --- FileNameCache directly -------------------------------------------------


def test_file_cache_roundtrip_and_atomic_write(tmp_path):
    path = tmp_path / "names.json"
    cache = FileNameCache(str(path))
    cache.set_many({"abc": "Crimpy"})
    assert not (tmp_path / "names.json.tmp").exists()  # temp file swapped away
    assert FileNameCache(str(path)).get_many(["abc", "missing"]) == {"abc": "Crimpy"}


def test_file_cache_corrupt_file_is_empty(tmp_path):
    path = tmp_path / "names.json"
    path.write_text("{not json")
    assert FileNameCache(str(path)).get_many(["abc"]) == {}


def test_file_cache_missing_file_is_empty(tmp_path):
    assert FileNameCache(str(tmp_path / "absent.json")).get_many(["abc"]) == {}


def test_file_cache_does_not_store_misses(tmp_path):
    # set_many({}) is a no-op; a resolve that finds nothing must leave no file behind.
    path = tmp_path / "names.json"
    FileNameCache(str(path)).set_many({})
    assert not path.exists()


def test_file_cache_merges_and_preserves_non_ascii(tmp_path):
    path = tmp_path / "names.json"
    cache = FileNameCache(str(path))
    cache.set_many({"a": "Café"})
    cache.set_many({"b": "Voie"})
    assert FileNameCache(str(path)).get_many(["a", "b"]) == {"a": "Café", "b": "Voie"}
    # ensure_ascii=False keeps the accented name literal on disk.
    assert "Café" in path.read_text(encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8")) == {"a": "Café", "b": "Voie"}
