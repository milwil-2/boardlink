from boardlink.kilter import (
    aggregate_difficulty_grade_id,
    build_grade_map,
    kilter_tables_to_ascents,
)


def test_builds_grade_map():
    tables = {"difficulty_grades": {"16": {"difficulty_grade_id": 16, "boulder_difficulty": "6C+/V6", "v_scale": "V6"}}}
    grades = build_grade_map(tables)
    assert grades[16] == {"grade": "6C+/V6", "v_grade": 6}


def test_aggregates_difficulty_grade_ids():
    assert aggregate_difficulty_grade_id([{"difficultyGradeId": 16}, {"difficultyGradeId": 18}]) == 17
    assert aggregate_difficulty_grade_id([]) is None


def test_tables_to_ascents_joins_climbs_and_filters_non_sends():
    tables = {
        "logs": {
            "L1": {"climb_uuid": "ABC", "angle": 40, "attempts": 2, "topped": 1, "created_at": "2026-05-01 10:00:00Z"},
            "L2": {"climb_uuid": "ABC", "angle": 40, "attempts": 5, "topped": 0, "created_at": "2026-05-02 10:00:00Z"},
        },
        "climbs": {"ABC": {"name": "Test Climb", "officialKilterDifficulty": 16}},
        "difficulty_grades": {"16": {"difficulty_grade_id": 16, "boulder_difficulty": "6C+/V6", "v_scale": "V6"}},
    }
    ascents = kilter_tables_to_ascents(tables)
    assert len(ascents) == 1
    a = ascents[0]
    assert a.climb_name == "Test Climb"
    assert a.grade == "6C+/V6"
    assert a.v_grade == 6
    assert a.tries == 2
    assert a.angle == 40
    assert a.date == "2026-05-01T10:00:00Z"


def test_returns_empty_without_a_logs_table():
    assert kilter_tables_to_ascents({"climbs": {}}) == []
