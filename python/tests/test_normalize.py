from boardlink.client import normalize_entry


def test_normalizes_an_aurora_row():
    a = normalize_entry(
        "kilter",
        {
            "board": "kilter",
            "angle": 40,
            "climb_name": "Some Climb",
            "date": "2026-05-01",
            "logged_grade": "7A",
            "displayed_grade": "7A+",
            "tries": 3,
            "is_mirror": False,
            "comment": " solid ",
        },
    )
    assert a is not None
    assert a.board == "kilter"
    assert a.climb_name == "Some Climb"
    assert a.grade == "7A+"
    assert a.user_grade == "7A"
    assert a.v_grade == 7  # from displayed "7A+"
    assert a.tries == 3
    assert a.angle == 40
    assert a.comment == "solid"


def test_moonboard_defaults_to_40_degrees():
    a = normalize_entry(
        "moonboard",
        {"climb_name": "M", "date": "2023-11-15", "grade": "6C+", "tries": 1},
    )
    assert a is not None
    assert a.angle == 40
    assert a.v_grade == 5


def test_row_without_date_is_dropped():
    assert normalize_entry("tension", {"grade": "7A", "tries": 1}) is None


def test_tolerates_alternate_field_names():
    a = normalize_entry(
        "moonboard",
        {"Name": "X", "DateClimbed": "2024-01-02", "Grade": "V4", "NumberOfTries": 2},
    )
    assert a is not None
    assert a.climb_name == "X"
    assert a.date == "2024-01-02"
    assert a.v_grade == 4
    assert a.tries == 2
