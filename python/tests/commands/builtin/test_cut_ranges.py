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

from mirage.commands.builtin.cut_ranges import (_OPEN_END, _cut_record,
                                                _select_positions,
                                                _split_records, parse_ranges)

_TRY = "Try 'cut --help' for more information."

# Measured against GNU coreutils 9.4 on `printf 'a,b,c\n'`. Every failing
# spec exits 1 and prints the message plus the Try line; GNU quotes from the
# first unparseable character onward, so `2-3x` and `1,2x` report `'x'` while
# `abc` reports the whole spec.
_GNU_REFUSALS = [
    ("2-3x", "fields", "invalid field value 'x'"),
    ("abc", "fields", "invalid field value 'abc'"),
    ("abc", "characters", "invalid byte/character position 'abc'"),
    ("0", "fields", "fields are numbered from 1"),
    ("3-1", "fields", "invalid decreasing range"),
    ("", "fields", "fields are numbered from 1"),
    ("1,2x", "fields", "invalid field value 'x'"),
    ("2 ", "fields", "fields are numbered from 1"),
    ("1-2-3", "fields", "invalid field range"),
    # An empty list element parses as field 0 wherever it sits, so a
    # leading, trailing or doubled comma all trip the zero check rather
    # than naming the comma.
    ("1,", "fields", "fields are numbered from 1"),
    (",1", "fields", "fields are numbered from 1"),
    ("1,,2", "fields", "fields are numbered from 1"),
]

# The -c/-b wording, measured on `printf 'abc\n'`. -b and -c share every
# string with each other; -f shares only `invalid decreasing range`, which
# carries no mode noun. Note that the two range strings are worded
# differently from each other: the position one joins its nouns with a
# slash, the range one spells out " or ".
_POSITION_REFUSALS = [
    ("0", "characters", "byte/character positions are numbered from 1"),
    ("0", "bytes", "byte/character positions are numbered from 1"),
    ("", "characters", "byte/character positions are numbered from 1"),
    ("2 ", "characters", "byte/character positions are numbered from 1"),
    ("1,", "characters", "byte/character positions are numbered from 1"),
    ("1-2-3", "characters", "invalid byte or character range"),
    ("1-2-3", "bytes", "invalid byte or character range"),
    ("3-1", "characters", "invalid decreasing range"),
    ("3-1", "bytes", "invalid decreasing range"),
    ("abc", "bytes", "invalid byte/character position 'abc'"),
    ("2-3x", "bytes", "invalid byte/character position 'x'"),
]


class TestParseRanges:

    def test_single(self):
        assert parse_ranges("3", "fields") == [(3, 3)]

    def test_closed_range(self):
        assert parse_ranges("2-5", "fields") == [(2, 5)]

    def test_open_high(self):
        assert parse_ranges("2-", "fields") == [(2, _OPEN_END)]

    def test_open_low(self):
        assert parse_ranges("-3", "fields") == [(1, 3)]

    def test_multiple(self):
        assert parse_ranges("1,3-4,7", "fields") == [(1, 1), (3, 4), (7, 7)]

    def test_open_high_is_valid_for_characters(self):
        assert parse_ranges("2-", "characters") == [(2, _OPEN_END)]

    def test_leading_zeros_are_plain_decimal(self):
        assert parse_ranges("03", "fields") == [(3, 3)]


class TestParseRangesRefusals:
    """GNU's four -f messages, -c/-b's own wording, and the two-line stderr."""

    @pytest.mark.parametrize("spec,mode,message",
                             _GNU_REFUSALS + _POSITION_REFUSALS)
    def test_message_and_try_line(self, spec, mode, message):
        with pytest.raises(ValueError) as refusal:
            parse_ranges(spec, mode)
        assert str(refusal.value) == f"cut: {message}\n{_TRY}"

    def test_zero_low_bound_of_a_range_is_the_zero_message(self):
        with pytest.raises(ValueError) as refusal:
            parse_ranges("0-2", "fields")
        assert str(refusal.value) == (f"cut: fields are numbered from 1\n"
                                      f"{_TRY}")


class TestSelectPositions:

    def test_ascending_dedup(self):
        assert _select_positions([(3, 3), (1, 1)], 4, False) == [1, 3]

    def test_overlap_dedup(self):
        assert _select_positions([(1, 3), (2, 4)], 6, False) == [1, 2, 3, 4]

    def test_open_clamped_to_n(self):
        assert _select_positions([(2, _OPEN_END)], 4, False) == [2, 3, 4]

    def test_complement(self):
        assert _select_positions([(2, 3)], 5, True) == [1, 4, 5]


class TestCutRecordChars:

    def test_char_range(self):
        assert _cut_record(b"abcdefgh", [(2, 5)], "characters", "\t", False,
                           False, None, False, None) == b"bcde"

    def test_char_overlap_dedup(self):
        assert _cut_record(b"abcdef", [(1, 3), (2, 4)], "characters", "\t",
                           False, False, None, False, None) == b"abcd"

    def test_char_open(self):
        assert _cut_record(b"abcdef", [(3, _OPEN_END)], "characters", "\t",
                           False, False, None, False, None) == b"cdef"


class TestCutRecordFields:

    def test_single_field(self):
        assert _cut_record(b"a\tb\tc", [(2, 2)], "fields", "\t", False, False,
                           None, False, None) == b"b"

    def test_field_order_is_file_order(self):
        assert _cut_record(b"a\tb\tc", [(3, 3), (1, 1)], "fields", "\t", False,
                           False, None, False, None) == b"a\tc"

    def test_open_field_range(self):
        assert _cut_record(b"a\tb\tc\td", [(2, _OPEN_END)], "fields", "\t",
                           False, False, None, False, None) == b"b\tc\td"

    def test_no_delimiter_passthrough(self):
        assert _cut_record(b"nodelim", [(2, 2)], "fields", "\t", False, False,
                           None, False, None) == b"nodelim"

    def test_custom_delimiter(self):
        assert _cut_record(b"root:x:0", [(1, 1)], "fields", ":", False, False,
                           None, False, None) == b"root"

    def test_complement(self):
        assert _cut_record(b"a\tb\tc", [(2, 2)], "fields", "\t", True, False,
                           None, False, None) == b"a\tc"


class TestSplitRecords:

    def test_drops_trailing_empty(self):
        assert _split_records(b"a\nb\n", False) == [b"a", b"b"]

    def test_keeps_final_without_newline(self):
        assert _split_records(b"a\nb", False) == [b"a", b"b"]

    def test_zero_terminated(self):
        assert _split_records(b"a\x00b\x00", True) == [b"a", b"b"]


# The refused remainder is rendered through gnulib `quote()`, the same
# rule every other coreutils diagnostic uses -- derived from all 255
# reachable bytes in `cut` itself and found identical to `nl`, `expand`,
# `shuf` and `expr` (ground truth NL3-A). Before this, cut interpolated
# the raw bytes, so `cut -f 2-3<e-acute>` emitted the character where GNU
# emits two octal escapes.
@pytest.mark.parametrize("mode,label", [
    ("fields", "invalid field value"),
    ("bytes", "invalid byte/character position"),
    ("characters", "invalid byte/character position"),
])
@pytest.mark.parametrize("spec,quoted", [
    ("2-3é", r"\303\251"),
    ("1,é", r"\303\251"),
    ("xé", r"x\303\251"),
    ("1,2\\x", r"\\x"),
    ("1,2'x", r"\'x"),
    ("1,2\tx", "x"),
    ("1,2\nx", r"\nx"),
    ("x\x01y", r"x\001y"),
    ("\U0001f600", r"\360\237\230\200"),
])
def test_cut_quotes_the_remainder_through_gnulib(mode, label, spec, quoted):
    with pytest.raises(ValueError) as refusal:
        parse_ranges(spec, mode)
    assert str(refusal.value).splitlines()[0] == f"cut: {label} '{quoted}'"


@pytest.mark.parametrize("spec", ["1-3", "1,2,3", "1-", "-3", "2"])
def test_cut_accepts_every_list_it_accepted_before(spec):
    """A control: the quoting change must not move what parses."""
    assert parse_ranges(spec, "fields")
