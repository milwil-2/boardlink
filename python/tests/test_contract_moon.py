"""MoonBoard golden-fixture contract test. Guards moon_entries_to_ascents against backend
response-shape drift, using the shared fixture the TypeScript suite also consumes.
"""

from contract_helpers import load_fixture, normalize_all

from boardlink.moon import moon_entries_to_ascents

FIXTURE = load_fixture("moon")


def test_moon_matches_golden_fixture():
    ascents = moon_entries_to_ascents(FIXTURE["raw"])
    assert normalize_all(ascents) == FIXTURE["expected"]


def test_moon_drops_projects_and_unparseable_dates():
    # Three raw entries (a project, an undated send, an unparseable date) must be dropped.
    ascents = moon_entries_to_ascents(FIXTURE["raw"])
    assert len(FIXTURE["raw"]) == len(ascents) + 3
