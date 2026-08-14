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


@pytest.mark.parametrize("value", ["+0", "++10", "-10", "+ 10", "10 ", "١٢"])
def test_bytes_rejects_bad_signs_and_non_ascii_digits(value):
    # '+' does not license zero, a second sign, a gap before the digits, or
    # trailing space; python's `\d` would have accepted Arabic-Indic digits.
    with pytest.raises(UsageError) as exc:
        parse_bytes_value(value)
    assert str(exc.value) == f"split: invalid number of bytes: '{value}'"


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
    # spec (pinned against coreutils 9.7).
    assert parse_chunks_value("2/3") == 3
    assert parse_chunks_value("+2/3") == 3
    assert parse_chunks_value("l/+2/3") == 3
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("+l/2")
    assert str(exc.value) == "split: invalid number of chunks: '+l/2'"
    with pytest.raises(UsageError) as exc:
        parse_chunks_value("x/3")
    assert str(exc.value) == "split: invalid number of chunks: 'x/3'"


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
