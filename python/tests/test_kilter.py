from boardlink.kilter import (
    KILTER_DIFFICULTY_GRADES,
    kilter_grade,
    kilter_log_to_ascent,
)


def test_grade_covers_every_scale():
    assert kilter_grade(26) == {
        "label": "7C/V9",
        "font": "7C",
        "v_scale": "V9",
        "v_grade": 9,
        "french": "8b",
        "yds": "5.13d",
    }
    assert KILTER_DIFFICULTY_GRADES[21]["french"] == "7b+"
    assert KILTER_DIFFICULTY_GRADES[21]["yds"] == "5.12c"


def test_grade_unknown_or_missing_id():
    assert kilter_grade(999) is None
    assert kilter_grade(None) is None


def test_log_to_ascent_maps_a_flashed_send():
    log = {
        "logUuid": "L1", "climbUuid": "ABC", "climbName": "floatin", "angle": 45,
        "attempts": 1, "flashed": True, "topped": True,
        "createdAt": "2026-08-12T20:14:24.373606Z", "currentDifficultyId": 26,
    }
    a = kilter_log_to_ascent(log)
    assert a.climb_name == "floatin"
    assert a.grade == "7C/V9"
    assert a.v_grade == 9
    assert a.tries == 1
    assert a.angle == 45
    assert a.date == "2026-08-12T20:14:24.373606Z"
    assert a.user_grade is None
    assert a.raw is log  # source record passed through


def test_log_to_ascent_sets_user_grade_when_it_differs():
    log = {
        "logUuid": "L2", "climbUuid": "DEF", "climbName": "Highgarden", "angle": 45,
        "attempts": 3, "flashed": False, "topped": True,
        "createdAt": "2026-08-10T03:35:40.743324Z", "currentDifficultyId": 26,
        "climbRating": {"difficultyGradeId": 25},
    }
    a = kilter_log_to_ascent(log)
    assert a.grade == "7C/V9"
    assert a.user_grade == "7B+/V8"
