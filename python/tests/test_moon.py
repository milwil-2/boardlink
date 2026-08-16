from boardlink.moon import (
    extract_input_value,
    moon_entries_to_ascents,
    moon_entry_to_ascent,
    parse_moon_date,
    parse_moon_tries,
)


def test_extracts_input_regardless_of_attribute_order():
    a = '<input name="__RequestVerificationToken" type="hidden" value="ABC123" />'
    b = '<input value="KEY9" name="form_key">'
    assert extract_input_value(a, "__RequestVerificationToken") == "ABC123"
    assert extract_input_value(b, "form_key") == "KEY9"
    assert extract_input_value(a, "missing") is None


def test_parses_dates_and_tries():
    assert parse_moon_date("15 Nov 2023") == "2023-11-15"
    assert parse_moon_date("3 Jan 2026") == "2026-01-03"
    assert parse_moon_date("garbage") is None
    assert parse_moon_tries("Flashed") == 1
    assert parse_moon_tries("3rd try") == 3
    assert parse_moon_tries("more than 3 tries") == 4
    assert parse_moon_tries("Project") is None


def test_maps_entry_and_skips_projects():
    sent = moon_entry_to_ascent({
        "DateClimbedAsString": "15 Nov 2023",
        "NumberOfTries": "2nd try",
        "Comment": " nice ",
        "Problem": {"Name": "Test", "Grade": "7A+", "UserGrade": "7A", "IsBenchmark": True},
    })
    assert sent is not None
    assert sent.board == "moonboard"
    assert sent.angle == 40
    assert sent.grade == "7A+"
    assert sent.v_grade == 7
    assert sent.tries == 2
    assert sent.is_benchmark is True
    assert sent.comment == "nice"

    project = moon_entry_to_ascent({"DateClimbedAsString": "16 Nov 2023", "NumberOfTries": "Project", "Problem": {"Grade": "8A"}})
    assert project is None


def test_batch_drops_projects_and_undated():
    ascents = moon_entries_to_ascents([
        {"DateClimbedAsString": "15 Nov 2023", "NumberOfTries": "Flashed", "Problem": {"Grade": "7A+"}},
        {"DateClimbedAsString": "15 Nov 2023", "NumberOfTries": "Project", "Problem": {"Grade": "8A"}},
        {"NumberOfTries": "Flashed", "Problem": {"Grade": "6C"}},
    ])
    assert len(ascents) == 1
    assert ascents[0].v_grade == 7
