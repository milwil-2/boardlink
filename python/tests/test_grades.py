from boardlink.grades import parse_v_grade


def test_plain_v_scale():
    assert parse_v_grade("V5") == 5
    assert parse_v_grade("V10") == 10
    assert parse_v_grade("v3") == 3


def test_compound_aurora_label():
    assert parse_v_grade("6C+/V5") == 5
    assert parse_v_grade("7A/V6") == 6


def test_font_grades_including_plus():
    assert parse_v_grade("7A") == 6
    assert parse_v_grade("7A+") == 7  # regression: the "+" must not be dropped
    assert parse_v_grade("6C+") == 5
    assert parse_v_grade("8A") == 11


def test_junk_returns_none():
    assert parse_v_grade("") is None
    assert parse_v_grade(None) is None
    assert parse_v_grade("project") is None
