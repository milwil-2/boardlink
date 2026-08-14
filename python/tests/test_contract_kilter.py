"""Kilter golden-fixture contract test. Guards kilter_log_to_ascent + connectKilter's topped filter
against backend response-shape drift, using the shared fixture the TypeScript suite also consumes.
"""

from contract_helpers import load_fixture, normalize_all

from boardlink.kilter import kilter_log_to_ascent

FIXTURE = load_fixture("kilter")


def _parse(raw):
    # Mirror connect_kilter: keep every log except the ones explicitly not topped, then map.
    return [kilter_log_to_ascent(log) for log in raw if log.get("topped") is not False]


def test_kilter_matches_golden_fixture():
    ascents = _parse(FIXTURE["raw"])
    assert normalize_all(ascents) == FIXTURE["expected"]


def test_kilter_drops_untopped_entries():
    # One raw entry (the unsent project, topped false) must be filtered out.
    assert len(FIXTURE["raw"]) == len(FIXTURE["expected"]) + 1


def test_kilter_passes_source_record_through_raw():
    ascents = _parse(FIXTURE["raw"])
    assert ascents[0].raw is FIXTURE["raw"][0]
