# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.commands.builtin.generic import split as split_generic
from mirage.commands.errors import UsageError

from mirage.commands.builtin.generic.split import (  # isort: skip
    parse_bytes_value, parse_chunks_value, parse_lines_value, parse_separator,
    parse_suffix_length, parse_suffix_start)

_TRY = "\nTry 'split --help' for more information."
_ALPHA_SUFFIXES = split_generic._ALPHA_SUFFIXES
_HEX_SUFFIXES = split_generic._HEX_SUFFIXES
_NUMERIC_SUFFIXES = split_generic._NUMERIC_SUFFIXES
_suffix_name = split_generic._suffix_name


def test_bytes_accepts_gnu_suffixes():
    assert parse_bytes_value("4") == 4
    assert parse_bytes_value("1k") == 1024
    assert parse_bytes_value("1kB") == 1000
    assert parse_bytes_value("1KiB") == 1024
    assert parse_bytes_value("2b") == 1024
    assert parse_bytes_value("1G") == 1024**3
    # split is base-10 only: a leading zero is not octal.
    assert parse_bytes_value("010") == 10
    # Counts past uintmax saturate rather than error in GNU (split -b 1Y
    # exits 0), so overflow spellings stay valid byte counts.
    assert parse_bytes_value("1Y") == 1024**8
    assert parse_bytes_value("18446744073709551616") == 2**64


def test_counts_accept_one_leading_plus_and_whitespace():
    # xstrtoumax skips leading whitespace and allows a single '+', so `-b +10`
    # and `-b " 10"` are valid (pinned against coreutils 9.7). Suffix start
    # values are the exception -- see the strict cases below.
    assert parse_bytes_value("+10") == 10
    assert parse_bytes_value(" 10") == 10
    assert parse_bytes_value("+10K") == 10240
    assert parse_lines_value("+2") == 2
    assert parse_chunks_value("l/+2") == 2
    assert parse_suffix_length("+2") == 2
    # -a is the one count GNU lets be zero, signed or not.
    assert parse_suffix_length("+0") == 0


@pytest.mark.parametrize("value", ["+0", "++10", "-10", "+ 10", "10 "])
def test_bytes_rejects_bad_signs(value):
    # '+' does not license zero, a second sign, a gap before the digits, or
    # trailing space.
    with pytest.raises(UsageError) as exc:
        parse_bytes_value(value)
    assert str(exc.value) == f"split: invalid number of bytes: '{value}'"


def test_bytes_rejects_non_ascii_digits():
    # python's `\d` would have accepted Arabic-Indic digits (int('١٢') is
    # 12), which JS /\d/ and GNU's C-locale parser reject. The refused
    # word is named through gnulib's quote(), so it comes back as one
    # octal escape per byte (measured: `split -b ١٢`).
    with pytest.raises(UsageError) as exc:
        parse_bytes_value("١٢")
    assert str(
        exc.value) == (r"split: invalid number of bytes: '\331\241\331\242'")


@pytest.mark.parametrize("value",
                         ["abc", "", "1x1b", "0x10", "0", "0K", "1g", "5c"])
def test_bytes_rejects_junk_zero_and_foreign_radix(value):
    with pytest.raises(UsageError) as exc:
        parse_bytes_value(value)
    assert str(exc.value) == f"split: invalid number of bytes: '{value}'"
    assert exc.value.exit_code == 1


def test_lines_rejects_junk_zero_and_suffixes():
    assert parse_lines_value("3") == 3
    for value in ["abc", "0", "1k"]:
        with pytest.raises(UsageError) as exc:
            parse_lines_value(value)
        assert str(exc.value) == f"split: invalid number of lines: '{value}'"


def test_chunks_quotes_only_the_count_of_a_spec():
    assert parse_chunks_value("4") == 4
    assert parse_chunks_value("l/4") == 4
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("l/abc")
    assert str(exc.value) == "split: invalid number of chunks: 'abc'"
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("l/0")
    assert str(exc.value) == "split: invalid number of chunks: '0'"


def test_chunks_validates_the_head_components():
    # The head takes an l/r kind letter or a signed K, never a signed kind:
    # `+2/3` and `l/+2/3` parse, while `+l/2` and `x/3` quote the whole
    # spec (pinned against coreutils 9.4).
    assert parse_chunks_value("2/3") == 3
    assert parse_chunks_value("+2/3") == 3
    assert parse_chunks_value("l/+2/3") == 3
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("+l/2")
    assert str(exc.value) == "split: invalid number of chunks: '+l/2'"
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("x/3")
    assert str(exc.value) == "split: invalid number of chunks: 'x/3'"


# Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
# `bytes` argv. GNU strips ONE leading `l/` or `r/` and then cuts what is
# left at its FIRST slash: a head it cannot parse names the whole
# remainder, everything else names the tail. mirage used to name the
# whole spec whenever the head was bad, which is right only when no kind
# prefix was typed. Mirrored in split.test.ts.
CHUNK_SPECS = [
    ("xé", r"x\303\251"),
    ("l/xé", r"x\303\251"),
    ("2/xé", r"x\303\251"),
    ("l/1/xé", r"x\303\251"),
    ("l/2/xé", r"x\303\251"),
    ("+l/2", "+l/2"),
    ("x/3", "x/3"),
    ("l/xé/4", r"x\303\251/4"),
    ("r/xé/4", r"x\303\251/4"),
    ("l/2/xé/4", r"x\303\251/4"),
    ("l/xé/yé", r"x\303\251/y\303\251"),
    ("xé/2", r"x\303\251/2"),
    ("l/2/3/4", "3/4"),
    ("1/2/3/4", "2/3/4"),
    ("l//4", "/4"),
    ("r/l/4", "l/4"),
    ("2/l/4", "l/4"),
    ("/", "/"),
    ("l", "l"),
    ("r", "r"),
    ("l/", ""),
    ("", ""),
    ("l/2/4/", "4/"),
]


@pytest.mark.parametrize("value,named", CHUNK_SPECS)
def test_chunks_names_the_component_gnu_names(value, named):
    with pytest.raises(UsageError) as exc:
        parse_chunks_value(value)
    assert str(exc.value) == f"split: invalid number of chunks: '{named}'"
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value,count", [
    ("4", 4),
    ("l/4", 4),
    ("r/4", 4),
    ("2/4", 4),
    ("l/2/4", 4),
    ("r/2/4", 4),
])
def test_chunks_accepts_the_shapes_gnu_accepts(value, count):
    assert parse_chunks_value(value) == count


def test_suffix_length_rejects_junk_but_allows_zero():
    assert parse_suffix_length("3") == 3
    assert parse_suffix_length("0") == 0
    with pytest.raises(UsageError) as exc:
        parse_suffix_length("1k")
    assert str(exc.value) == "split: invalid suffix length: '1k'"


def test_separator_takes_one_byte_and_the_nul_spelling():
    # `\0` is the only escape GNU reads, and it is two characters on the
    # command line; everything else is taken literally, so a lone backslash
    # and a digit zero are ordinary separators.
    assert parse_separator(None) == b"\n"
    assert parse_separator("\\0") == b"\0"
    assert parse_separator("X") == b"X"
    assert parse_separator("0") == b"0"
    assert parse_separator("\\") == b"\\"


@pytest.mark.parametrize("value", ["XY", "abc", "\\n", "\\t", "é"])
def test_separator_rejects_multi_byte_values(value):
    # This used to keep the whole byte string as the separator, splitting on
    # 'XY' where GNU refuses to run at all. 'é' is one character but two
    # UTF-8 bytes, and GNU counts bytes.
    with pytest.raises(UsageError) as exc:
        parse_separator(value)
    assert str(exc.value) == f"split: multi-character separator '{value}'"
    assert exc.value.exit_code == 1


def test_separator_rejects_an_empty_value():
    with pytest.raises(UsageError) as exc:
        parse_separator("")
    assert str(exc.value) == "split: empty record separator"
    assert exc.value.exit_code == 1


def test_suffix_names_auto_lengthen_like_gnu():
    # GNU reserves the last alphabet character as a growth prefix:
    # aa..yz then zaaa.., 00..89 then 9000..9899 then 990000.., 00..ef
    # then f000.. (pinned against coreutils 9.7). Index 676 must never
    # wrap back onto aa.
    assert _suffix_name(649, _ALPHA_SUFFIXES, True, 2, 0) == "yz"
    assert _suffix_name(650, _ALPHA_SUFFIXES, True, 2, 0) == "zaaa"
    assert _suffix_name(651, _ALPHA_SUFFIXES, True, 2, 0) == "zaab"
    assert _suffix_name(89, _NUMERIC_SUFFIXES, True, 2, 0) == "89"
    assert _suffix_name(90, _NUMERIC_SUFFIXES, True, 2, 0) == "9000"
    assert _suffix_name(989, _NUMERIC_SUFFIXES, True, 2, 0) == "9899"
    assert _suffix_name(990, _NUMERIC_SUFFIXES, True, 2, 0) == "990000"
    assert _suffix_name(239, _HEX_SUFFIXES, True, 2, 0) == "ef"
    assert _suffix_name(240, _HEX_SUFFIXES, True, 2, 0) == "f000"


def test_suffix_names_exhaust_fixed_widths():
    # An explicit -a width or an explicit start value pins the width;
    # GNU keeps the chunks already written and fails on the next name.
    assert _suffix_name(675, _ALPHA_SUFFIXES, False, 2, 0) == "zz"
    with pytest.raises(UsageError) as exc:
        _suffix_name(676, _ALPHA_SUFFIXES, False, 2, 0)
    assert str(exc.value) == "split: output file suffixes exhausted"
    assert exc.value.exit_code == 1
    assert _suffix_name(1, _NUMERIC_SUFFIXES, False, 2, 98) == "99"
    with pytest.raises(UsageError):
        _suffix_name(2, _NUMERIC_SUFFIXES, False, 2, 98)
    # Deliberate divergence: GNU 9.7 with --hex-suffixes=f0 walks past its
    # alphabet into non-hex names; mirage exhausts cleanly at the width.
    assert _suffix_name(15, _HEX_SUFFIXES, False, 2, 0xf0) == "ff"
    with pytest.raises(UsageError):
        _suffix_name(16, _HEX_SUFFIXES, False, 2, 0xf0)


def test_suffix_length_overflows_past_uintmax():
    # GNU refuses widths past 2**64 - 1 at parse time; byte and line
    # counts saturate instead (split -b 1Y is a valid spelling of "one
    # output file"), so only -a gets the Value-too-large tail.
    assert parse_suffix_length("18446744073709551615") == 2**64 - 1
    with pytest.raises(UsageError) as exc:
        parse_suffix_length("18446744073709551616")
    assert str(exc.value) == ("split: invalid suffix length: "
                              "'18446744073709551616': Value too large "
                              "for defined data type")


@pytest.mark.parametrize("value", ["+5", " 5"])
def test_suffix_start_rejects_signs_and_whitespace(value):
    # Unlike the counts, GNU validates start values itself rather than through
    # xstrtoumax: `--numeric-suffixes=+5` and `=" 5"` are both errors.
    with pytest.raises(UsageError) as exc:
        parse_suffix_start(value, False, 2)
    assert str(exc.value) == (f"split: '{value}': invalid start value "
                              "for numerical suffix" + _TRY)


def test_suffix_start_parses_hex_in_hex_mode():
    assert parse_suffix_start("07", False, 2) == 7
    assert parse_suffix_start("007", False, 2) == 7
    assert parse_suffix_start("10", True, 2) == 16
    assert parse_suffix_start("ff", True, 2) == 255


def test_suffix_start_junk_and_width_overflow():
    with pytest.raises(UsageError) as exc:
        parse_suffix_start("zz", False, 2)
    assert str(exc.value) == ("split: 'zz': invalid start value "
                              "for numerical suffix" + _TRY)
    with pytest.raises(UsageError) as exc:
        parse_suffix_start("100", False, 2)
    assert str(exc.value) == ("split: numerical suffix start value is "
                              "too large for the suffix length" + _TRY)


def test_suffix_start_hex_junk_says_hexadecimal():
    with pytest.raises(UsageError) as exc:
        parse_suffix_start("zz", True, 2)
    assert str(exc.value) == ("split: 'zz': invalid start value "
                              "for hexadecimal suffix" + _TRY)


# Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
# `bytes` argv: all four of split's count clauses name the refused word
# through gnulib's quote(), so the value is escaped rather than
# interpolated raw. `-n` quotes only the trailing component, which is the
# one the escaping applies to. Mirrored in split.test.ts.
QUOTED_VALUES = [
    ("1é", r"1\303\251"),
    ("1\r", r"1\r"),
    ("1\x01", r"1\001"),
    ("1\x7f", r"1\177"),
    ("1'", r"1\'"),
    ("1\\", r"1\\"),
    ("", ""),
]


@pytest.mark.parametrize("value,escaped", QUOTED_VALUES)
def test_bytes_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_bytes_value(value)
    assert str(exc.value) == f"split: invalid number of bytes: '{escaped}'"


@pytest.mark.parametrize("value,escaped", QUOTED_VALUES)
def test_lines_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_lines_value(value)
    assert str(exc.value) == f"split: invalid number of lines: '{escaped}'"


@pytest.mark.parametrize("value,escaped", QUOTED_VALUES)
def test_chunks_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_chunks_value(value)
    assert str(exc.value) == f"split: invalid number of chunks: '{escaped}'"


@pytest.mark.parametrize("value,escaped", QUOTED_VALUES)
def test_chunks_clause_quotes_only_the_escaped_tail(value, escaped):
    """`-n l/<w>` names the component, so the escaping travels with it."""
    with pytest.raises(UsageError) as exc:
        parse_chunks_value(f"l/{value}")
    assert str(exc.value) == f"split: invalid number of chunks: '{escaped}'"


@pytest.mark.parametrize("value,escaped", QUOTED_VALUES)
def test_suffix_length_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_suffix_length(value)
    assert str(exc.value) == f"split: invalid suffix length: '{escaped}'"


def test_suffix_length_overflow_clause_quotes_the_word():
    """The Value-too-large tail names the same word, escaped the same way.

    The digit run cannot itself carry a byte quote() would escape, so a
    blank leading run is what puts one in the slot: `strtoumax` skips
    leading whitespace, and the raw argument including it is what GNU
    quotes (measured: `split -a $'\\r18446744073709551616'`).
    """
    with pytest.raises(UsageError) as exc:
        parse_suffix_length("\r18446744073709551616")
    assert str(exc.value) == (
        r"split: invalid suffix length: '\r18446744073709551616': "
        "Value too large for defined data type")


# The suffix-start clause puts its word FIRST, where the four count
# clauses above put it last, and it escapes the word the same way
# (measured on GNU coreutils 9.4 for both spellings). The empty word is
# absent on purpose: `--numeric-suffixes=` is not a refusal in GNU at
# all, it exits 0, which is a separate divergence from the escaping.
@pytest.mark.parametrize("value,escaped",
                         [row for row in QUOTED_VALUES if row[0]])
def test_suffix_start_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_suffix_start(value, False, 2)
    assert str(exc.value) == (
        f"split: '{escaped}': invalid start value for numerical suffix" + _TRY)
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value,escaped",
                         [row for row in QUOTED_VALUES if row[0]])
def test_hex_suffix_start_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_suffix_start(value, True, 2)
    assert str(exc.value) == (
        f"split: '{escaped}': invalid start value for hexadecimal suffix" +
        _TRY)
    assert exc.value.exit_code == 1
