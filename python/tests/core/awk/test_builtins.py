import math

import pytest

from mirage.core.awk.builtins import (match_position, next_random, safe_fmod,
                                      safe_log, safe_pow, safe_sqrt,
                                      split_record, sprintf, substitute,
                                      substr, take_record)
from mirage.core.awk.errors import AwkRuntimeError, AwkSyntaxError
from mirage.core.awk.value import num, strnum, text


@pytest.mark.parametrize("start,length,expected", [
    (1, 5, "hello"),
    (7, None, "world"),
    (0, 3, "hel"),
    (-1, 3, "hel"),
    (5, 100, "o world"),
    (20, None, ""),
    (2.7, 2.5, "el"),
    (1, 0, ""),
    (math.nan, 2, "he"),
])
def test_substr(start, length, expected):
    assert substr("hello world", start, length) == expected


def test_substr_counts_characters_not_bytes():
    assert substr("héllo", 2, 2) == "él"
    assert substr("a😀b", 2, 1) == "😀"


@pytest.mark.parametrize("pattern,template,subject,globally,expected", [
    ("o", "0", "foo boo", True, (4, "f00 b00")),
    ("o", "0", "foo boo", False, (1, "f0o boo")),
    ("a", "[&]", "aaa", False, (1, "[a]aa")),
    ("\\.", "\\&", "a.b.c", True, (2, "a&b&c")),
    ("l*", "-", "hello", True, (4, "-h-e-o-")),
    ("x*", "-", "", True, (1, "-")),
    ("z", "y", "abc", True, (0, "abc")),
    ("b", "\\\\", "abc", True, (1, "a\\\\c")),
    ("b", "\\\\&", "abc", True, (1, "a\\bc")),
    ("b", "x\\y", "abc", True, (1, "ax\\yc")),
])
def test_substitute(pattern, template, subject, globally, expected):
    assert substitute(pattern, template, subject, globally) == expected


def test_match_position():
    assert match_position("o+", "foobar") == (2, 2)
    assert match_position("y", "x") == (0, -1)
    assert match_position("l+", "héllo") == (3, 2)


@pytest.mark.parametrize("record,separator,expected", [
    ("  a  b\tc \n", " ", ["a", "b", "c"]),
    ("", " ", []),
    ("a:b::c", ":", ["a", "b", "", "c"]),
    ("a1b22c", "[0-9]+", ["a", "b", "c"]),
    ("a.b", ".", ["a", "b"]),
    ("a|b", "|", ["a", "b"]),
    ("a b\tc d", "\t", ["a b", "c d"]),
    ("abc", "", ["a", "b", "c"]),
    ("", ":", []),
    ("abc", "x*", ["abc"]),
])
def test_split_record(record, separator, expected):
    assert split_record(record, separator) == expected


@pytest.mark.parametrize("record,separator,expected", [
    ("a:b\nc", ":", ["a", "b", "c"]),
    ("a b\nc", " ", ["a", "b", "c"]),
    ("a\tb\nc", "\t", ["a", "b", "c"]),
    ("a:b\nc", "[:]", ["a", "b\nc"]),
])
def test_split_record_in_paragraph_mode(record, separator, expected):
    assert split_record(record, separator, True) == expected


def drain(buffer: str, separator: str, final: bool) -> tuple[list[str], int]:
    records: list[str] = []
    start = 0
    while True:
        record, start = take_record(buffer, start, separator, final)
        if record is None:
            return records, start
        records.append(record)


@pytest.mark.parametrize("buffer,separator,expected", [
    ("a\nb\n", "\n", ["a", "b"]),
    ("a\n\nb", "\n", ["a", "", "b"]),
    ("a:b", ":", ["a", "b"]),
    ("a:b:\n", ":", ["a", "b", "\n"]),
    ("a:b:", ":", ["a", "b"]),
    ("a.b|c", ".", ["a", "b|c"]),
    ("a😀b", "😀", ["a", "b"]),
    ("\n\na b\nc\n\n\n\nd e\n\n", "", ["a b\nc", "d e"]),
    ("a\n \nb\n", "", ["a\n \nb"]),
    ("a\n \n", "", ["a\n "]),
    ("\n\n\n", "", []),
    ("", "", []),
    ("a12b345c", "[0-9]+", ["a", "b", "c"]),
    ("a12b34", "[0-9]+", ["a", "b"]),
    ("axxbyc", "x*", ["a", "byc"]),
    ("a;b,c", ";|,", ["a", "b", "c"]),
])
def test_take_record_at_the_end_of_input(buffer, separator, expected):
    records, start = drain(buffer, separator, True)
    assert records == expected
    assert start == len(buffer)


@pytest.mark.parametrize("buffer,separator,expected,rest", [
    ("a\nb", "\n", ["a"], "b"),
    ("a\n\nb\n", "", ["a"], "b\n"),
    ("a\n\n", "", [], "a\n\n"),
    ("a\n", "", [], "a\n"),
    ("a12", "[0-9]+", [], "a12"),
    ("a12b", "[0-9]+", ["a"], "b"),
    ("ab", "x*", [], "ab"),
])
def test_take_record_waits_for_a_separator_that_could_grow(
        buffer, separator, expected, rest):
    records, start = drain(buffer, separator, False)
    assert records == expected
    assert buffer[start:] == rest


def test_take_record_with_a_bad_regex_is_a_syntax_error():
    with pytest.raises(AwkSyntaxError):
        take_record("ab", 0, "[a", True)


@pytest.mark.parametrize("fmt,args,expected", [
    ("%d|%5d|%-5d|%05d|%+d|% d", [num(42)] * 6,
     "42|   42|42   |00042|+42| 42"),
    ("%s|%10s|%-10s|%.2s",
     [text("hi"), text("hi"),
      text("hi"), text("hello")], "hi|        hi|hi        |he"),
    ("%f|%.2f|%10.3f", [num(3.14159)] * 3, "3.141590|3.14|     3.142"),
    ("%e|%.3e|%g|%G",
     [num(31415.9), num(31415.9),
      num(0.00001234), num(1e20)], "3.141590e+04|3.142e+04|1.234e-05|1E+20"),
    ("%x|%X|%o|%#x|%#o",
     [num(255), num(255), num(8), num(255),
      num(8)], "ff|FF|10|0xff|010"),
    ("%c|%c|%%", [num(65), text("hello")], "A|h|%"),
    ("%d %d %d", [num(-3.9), strnum("12abc"),
                  text("abc")], "-3 12 0"),
    ("%*d|%-*d|%.*f",
     [num(5), num(42), num(5),
      num(42), num(2), num(3.14159)], "   42|42   |3.14"),
    ("%x", [num(-1)], "ffffffffffffffff"),
    ("%d", [num(2.0**70)], "1180591620717411303424"),
    ("%.3d|%.0d", [num(7), num(0)], "007|"),
    ("%5%|%z", [], "%5%|%z"),
    ("100%", [], "100%"),
])
def test_sprintf(fmt, args, expected):
    assert sprintf(fmt, args, "%.6g") == expected


def test_sprintf_with_too_few_arguments_is_fatal():
    with pytest.raises(AwkRuntimeError, match="not enough arguments"):
        sprintf("%s %s", [text("only")], "%.6g")


def test_math_edges_answer_like_c():
    assert safe_log(0) == -math.inf
    assert math.isnan(safe_log(-1))
    assert math.isnan(safe_sqrt(-1))
    assert safe_pow(0, -1) == math.inf
    assert safe_pow(-10, 1001) == -math.inf
    assert math.isnan(safe_pow(-8, 0.5))
    assert safe_pow(2, 10) == 1024
    assert safe_pow(1, math.nan) == 1
    assert safe_pow(-1, math.inf) == 1
    assert math.isnan(safe_fmod(math.inf, 2))
    assert safe_fmod(-7, 3) == -1


def test_rand_sequence_is_the_same_on_both_hosts():
    state = 0
    drawn = []
    for _ in range(3):
        state, value = next_random(state)
        drawn.append(value)
    assert drawn == [
        0.26642920868471265, 0.0003297457005828619, 0.2232720274478197
    ]
