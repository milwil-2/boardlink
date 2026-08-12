from boardlink.aurora import _sync_to_ascents


def test_maps_a_sync_response_resolving_grades_from_the_bundled_table():
    ascents = _sync_to_ascents(
        "tension",
        {
            "ascents": [
                {"climbed_at": "2026-05-01 19:30:00", "difficulty": 23, "angle": 40, "bid_count": 2, "climb_uuid": "abc"},
                {"climbed_at": "2026-05-02 10:00:00", "difficulty": 20, "is_listed": False},
                {"difficulty": 23},
            ],
        },
    )
    assert len(ascents) == 1
    a = ascents[0]
    assert a.board == "tension"
    assert a.grade == "7A+/V7"  # difficulty 23 -> 7A+/V7, not the old (23-10)=V13 guess
    assert a.v_grade == 7
    assert a.tries == 3  # bid_count + 1
    assert a.angle == 40
    assert a.date == "2026-05-01T19:30:00Z"
    assert a.raw["climb_uuid"] == "abc"  # source row passed through


def test_uses_attempt_id_as_tries_when_present():
    ascents = _sync_to_ascents(
        "tension",
        {"ascents": [{"climbed_at": "2026-05-01 19:30:00", "difficulty": 20, "attempt_id": 1, "bid_count": 9}]},
    )
    assert ascents[0].tries == 1  # flash
