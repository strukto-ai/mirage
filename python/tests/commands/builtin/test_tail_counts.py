import math

import pytest

from mirage.commands.builtin.tail_counts import (number_flag_error,
                                                 parse_byte_count,
                                                 parse_counts, parse_seconds)


def test_bare_count_counts_back_from_the_end():
    counts = parse_counts("3", None)
    assert counts.lines == 3
    assert counts.from_line is None


def test_leading_plus_counts_forward_for_lines():
    counts = parse_counts("+3", None)
    assert counts.from_line == 3
    assert counts.lines is None


def test_leading_plus_counts_forward_for_bytes():
    """GNU `tail -c +3` starts at byte 3; taking abs() gave the LAST three."""
    counts = parse_counts(None, "+3")
    assert counts.from_byte == 3
    assert counts.byte_count is None


def test_negative_bytes_still_count_back_from_the_end():
    counts = parse_counts(None, "-3")
    assert counts.byte_count == -3
    assert counts.from_byte is None


def test_unset_flags_stay_none_so_the_generic_picks_its_default():
    counts = parse_counts(None, None)
    assert counts == parse_counts(None, None)
    assert (counts.lines, counts.from_line, counts.byte_count,
            counts.from_byte) == (None, None, None, None)


def test_both_flags_are_parsed_independently():
    counts = parse_counts("+2", "5")
    assert counts.from_line == 2
    assert counts.byte_count == 5


def test_byte_counts_accept_gnu_size_suffixes():
    assert parse_byte_count("2M") == 2 * 1024 * 1024
    assert parse_byte_count("3kB") == 3000
    assert parse_counts(None, "+2M").from_byte == 2 * 1024 * 1024


class TestNumberFlagError:

    def test_valid_numbers_pass(self):
        assert number_flag_error("head", "5", None) is None
        assert number_flag_error("tail", "+3", None) is None
        assert number_flag_error("head", None, "-2") is None

    def test_invalid_lines(self):
        assert number_flag_error(
            "head", "abc", None) == "head: invalid number of lines: 'abc'\n"

    def test_invalid_bytes(self):
        assert number_flag_error(
            "tail", None, "xyz") == "tail: invalid number of bytes: 'xyz'\n"

    def test_unicode_digits_are_invalid(self):
        # python's \d also matches Unicode digits (int('١٢') is 12), which
        # JS /\d/ and GNU's C-locale parsers reject. The word comes back
        # through gnulib's quote(), so each byte of it is an octal escape
        # (measured: `head -n ١٢`).
        assert number_flag_error("head", "١٢", None) == (
            "head: invalid number of lines: '\\331\\241\\331\\242'\n")
        assert number_flag_error(
            "tail", None,
            "٥") == ("tail: invalid number of bytes: '\\331\\245'\n")


# Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
# `bytes` argv (`head -c <w>`, `tail -n <w>`): both clauses name the word
# through gnulib's quote(), so the value is escaped rather than
# interpolated raw. Mirrored in tail_counts.test.ts.
QUOTED_COUNTS = [
    ("1é", r"1\303\251"),
    ("1\r", r"1\r"),
    ("1\x01", r"1\001"),
    ("1\x7f", r"1\177"),
    ("1'", r"1\'"),
    ("1\\", r"1\\"),
    ("", ""),
    # python's \d also matches Arabic-Indic digits; GNU's C-locale parser
    # rejects them and names the word one octal escape per byte.
    ("١٢", r"\331\241\331\242"),
]


@pytest.mark.parametrize("value,escaped", QUOTED_COUNTS)
def test_lines_clause_quotes_the_word(value, escaped):
    assert number_flag_error(
        "tail", value,
        None) == (f"tail: invalid number of lines: '{escaped}'\n")


@pytest.mark.parametrize("value,escaped", QUOTED_COUNTS)
def test_bytes_clause_quotes_the_word(value, escaped):
    assert number_flag_error(
        "head", None,
        value) == (f"head: invalid number of bytes: '{escaped}'\n")


# `parse_seconds` is C `strtod` as `xstrtod` reads it. Every row below is
# a measured GNU coreutils 9.4 answer for `tail -s <v> f` under
# `LC_ALL=C` with a raw `bytes` argv: exit 0 means the grammar took the
# value (and `0 <= s` held), exit 1 means one of the two refused it.
# Mirrored in tail_counts.test.ts.
@pytest.mark.parametrize("value,expected", [
    (" 1", 1.0),
    ("\r1", 1.0),
    ("\t1", 1.0),
    ("+1", 1.0),
    ("-1", -1.0),
    (".5", 0.5),
    ("1.", 1.0),
    ("1e2", 100.0),
    ("+.5e1", 5.0),
    ("00", 0.0),
    ("5", 5.0),
    ("0x10", 16.0),
    ("0x1p4", 16.0),
    ("0x.8p1", 1.0),
    ("0x10.8", 16.5),
])
def test_parse_seconds_reads_what_strtod_reads(value, expected):
    assert parse_seconds(value) == expected


@pytest.mark.parametrize("value", ["inf", "infinity", "INF", "-inf"])
def test_parse_seconds_takes_infinity(value):
    """GNU ACCEPTS `tail -s inf`: `0 <= inf` holds, so only the sign
    decides, and `-inf` is then refused by the caller's range test."""
    got = parse_seconds(value)
    assert got is not None and math.isinf(got)


@pytest.mark.parametrize("value", ["nan", "NAN", "nan(x)", "-nan"])
def test_parse_seconds_takes_nan_and_leaves_the_range_to_the_caller(value):
    """glibc's strtod reads `nan` and `nan(chars)`; GNU then refuses it
    because `0 <= nan` is false, which is the caller's half of the
    test."""
    got = parse_seconds(value)
    assert got is not None and math.isnan(got)


@pytest.mark.parametrize("value", [
    "1\r",
    "1 ",
    "1\t",
    "",
    "1_0",
    "1x",
    "0x",
    "1e",
    "1e+",
    "1,5",
    ".",
    "1.5.5",
    "0xp1",
    "inf inity",
])
def test_parse_seconds_refuses_any_leftover(value):
    """`xstrtod` demands the WHOLE string; trailing whitespace is not
    strtod's, which is why `float()` and `Number()` were both too
    lenient."""
    assert parse_seconds(value) is None
