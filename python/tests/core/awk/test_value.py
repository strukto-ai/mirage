import math

import pytest

from mirage.core.awk.value import (UNINIT, ValueKind, compare, format_num,
                                   is_true, looks_numeric, num, parse_number,
                                   strnum, text, to_int, to_num, to_str)


@pytest.mark.parametrize("raw,expected", [
    ("12", True),
    (" +1.5e3 ", True),
    (".5", True),
    ("7.", True),
    ("0x1A", False),
    ("1e", False),
    ("", False),
    ("abc", False),
    ("٣", False),
])
def test_looks_numeric(raw, expected):
    assert looks_numeric(raw) is expected


def test_strnum_tags_only_numeric_looking_input():
    assert strnum("10").kind is ValueKind.STRNUM
    assert strnum("10x").kind is ValueKind.STR
    assert strnum("").kind is ValueKind.STR


@pytest.mark.parametrize("raw,expected", [
    ("12abc", 12.0),
    ("  42  ", 42.0),
    (".5x", 0.5),
    ("1e", 1.0),
    ("0x1A", 0.0),
    ("abc", 0.0),
    ("-", 0.0),
])
def test_parse_number_reads_a_prefix(raw, expected):
    assert parse_number(raw) == expected


@pytest.mark.parametrize("value,expected", [
    (17.0, "17"),
    (-0.0, "0"),
    (1e6, "1000000"),
    (1e16, "10000000000000000"),
    (2.0**60, "1152921504606846976"),
    (0.1 + 0.2, "0.3"),
    (1 / 3, "0.333333"),
    (1e-7, "1e-07"),
    (123456789.123, "1.23457e+08"),
    (math.inf, "inf"),
    (-math.inf, "-inf"),
    (math.nan, "nan"),
])
def test_format_num(value, expected):
    assert format_num(value, "%.6g") == expected


def test_format_num_honours_convfmt_and_survives_a_bad_one():
    assert format_num(3.14159, "%.2f") == "3.14"
    assert format_num(3.14159, "%d") == "3.14159"
    assert format_num(3.14159, "junk") == "3.14159"


def test_to_int_truncates_and_clamps():
    assert to_int(3.9) == 3
    assert to_int(-3.9) == -3
    assert to_int(math.nan) == 0
    assert to_int(math.inf) == 2**63
    assert to_int(-math.inf) == -(2**63)


def test_uninit_is_zero_and_empty():
    assert to_num(UNINIT) == 0.0
    assert to_str(UNINIT, "%.6g") == ""
    assert not is_true(UNINIT)


def test_truthiness():
    assert is_true(num(1))
    assert not is_true(num(0))
    assert is_true(text("0"))
    assert not is_true(strnum("0"))
    assert not is_true(text(""))


def test_compare_is_numeric_only_between_numeric_kinds():
    assert compare(strnum("10"), num(9), "%.6g") == 1
    assert compare(text("10"), num(9), "%.6g") == -1
    assert compare(UNINIT, num(0), "%.6g") == 0
    assert compare(text(""), num(0), "%.6g") == -1
    assert compare(text("abc"), text("abd"), "%.6g") == -1
