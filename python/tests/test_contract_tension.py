"""Tension (Aurora) golden-fixture contract test. Guards _sync_to_ascents against backend
response-shape drift, using the shared fixture the TypeScript suite also consumes.
"""

from contract_helpers import load_fixture, normalize_all

from boardlink.aurora import _sync_to_ascents

FIXTURE = load_fixture("tension")


def test_tension_matches_golden_fixture():
    ascents = _sync_to_ascents("tension", FIXTURE["raw"])
    assert normalize_all(ascents) == FIXTURE["expected"]


def test_tension_drops_unlisted_and_undated_entries():
    # Two raw ascents (an unlisted one and one with no climbed_at) must be dropped.
    ascents = _sync_to_ascents("tension", FIXTURE["raw"])
    assert len(FIXTURE["raw"]["ascents"]) == len(ascents) + 2
