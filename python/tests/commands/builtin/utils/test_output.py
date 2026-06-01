from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_record_text,
                                                  format_records)


def test_format_records_empty_returns_empty_bytes():
    assert format_records([]) == b""


def test_format_records_single_record_terminates_line():
    assert format_records(["a"]) == b"a\n"


def test_format_records_multiple_records_terminates_last_line():
    assert format_records(["a", "b"]) == b"a\nb\n"


def test_format_optional_records_empty_returns_none():
    assert format_optional_records([]) is None


def test_format_record_text_multiple_records_terminates_last_line():
    assert format_record_text(["a", "b"]) == "a\nb\n"
