import pytest

from mirage.utils.records import (
    as_array,
    as_object,
    first_text,
    is_plain_object,
    pick_bool_or_none,
    pick_number_or_none,
    pick_string,
    pick_string_array,
    records,
    require_id,
    string_of,
)


def test_empty_text_and_missing_label_are_distinct():
    row = {"preferred": "", "fallback": "name", "wrong": 42}
    assert pick_string(row, "preferred", "fallback") == ""
    assert first_text(row, "preferred", "fallback") == "name"
    assert pick_string(row, "wrong", "fallback") == "name"
    assert string_of(row, "missing") == ""
    assert pick_string(row, "missing") is None


def test_only_requested_json_types_are_kept():
    row = {
        "yes": True,
        "zero": 0,
        "strings": ["a", None, 2, ""],
        "text": "true",
    }
    assert pick_bool_or_none(row, "yes") is True
    assert pick_bool_or_none(row, "text") is None
    assert pick_number_or_none(row, "zero") == 0
    assert pick_number_or_none(row, "yes") is None
    assert pick_string_array(row, "strings") == ["a", ""]
    assert records([None, [], 4, row]) == [row]
    assert as_array({}) == []
    assert as_object([]) == {}
    assert not is_plain_object(set())
    assert is_plain_object({})


@pytest.mark.parametrize("value", ["", 0, None, False])
def test_ids_are_not_coerced(value):
    assert require_id({"id": "0"}) == "0"
    with pytest.raises(ValueError, match="record missing id"):
        require_id({"id": value})
