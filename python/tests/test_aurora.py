from boardlink.aurora import _sync_to_ascents


def test_maps_a_sync_response_with_grades():
    ascents = _sync_to_ascents(
        "tension",
        {
            "ascents": [
                {"climbed_at": "2026-05-01 19:30:00", "difficulty": 15, "angle": 40, "bid_count": 2},
                {"climbed_at": "2026-05-02 10:00:00", "difficulty": 20, "is_listed": False},
                {"difficulty": 15},
            ],
            "difficulty_grades": [
                {"difficulty": 15, "boulder_name": "6C+/V5"},
                {"difficulty": 20, "boulder_name": "7C+/V10"},
            ],
        },
    )
    assert len(ascents) == 1
    a = ascents[0]
    assert a.board == "tension"
    assert a.grade == "6C+/V5"
    assert a.v_grade == 5
    assert a.tries == 3
    assert a.angle == 40
    assert a.date == "2026-05-01T19:30:00Z"


def test_falls_back_to_approximate_v_without_a_grade_table():
    ascents = _sync_to_ascents("tension", {"ascents": [{"climbed_at": "2026-05-01 19:30:00", "difficulty": 16}]})
    assert ascents[0].grade == "V6"
