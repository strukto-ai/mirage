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

from mirage.commands.builtin.cut_helper import (OPEN_END, cut_record,
                                                parse_ranges, select_positions,
                                                split_records)


class TestParseRanges:

    def test_single(self):
        assert parse_ranges("3") == [(3, 3)]

    def test_closed_range(self):
        assert parse_ranges("2-5") == [(2, 5)]

    def test_open_high(self):
        assert parse_ranges("2-") == [(2, OPEN_END)]

    def test_open_low(self):
        assert parse_ranges("-3") == [(1, 3)]

    def test_multiple(self):
        assert parse_ranges("1,3-4,7") == [(1, 1), (3, 4), (7, 7)]


class TestSelectPositions:

    def test_ascending_dedup(self):
        assert select_positions([(3, 3), (1, 1)], 4, False) == [1, 3]

    def test_overlap_dedup(self):
        assert select_positions([(1, 3), (2, 4)], 6, False) == [1, 2, 3, 4]

    def test_open_clamped_to_n(self):
        assert select_positions([(2, OPEN_END)], 4, False) == [2, 3, 4]

    def test_complement(self):
        assert select_positions([(2, 3)], 5, True) == [1, 4, 5]


class TestCutRecordChars:

    def test_char_range(self):
        assert cut_record(b"abcdefgh", [(2, 5)], "characters", "\t", False,
                          False, None, False, None) == b"bcde"

    def test_char_overlap_dedup(self):
        assert cut_record(b"abcdef", [(1, 3), (2, 4)], "characters", "\t",
                          False, False, None, False, None) == b"abcd"

    def test_char_open(self):
        assert cut_record(b"abcdef", [(3, OPEN_END)], "characters", "\t",
                          False, False, None, False, None) == b"cdef"


class TestCutRecordFields:

    def test_single_field(self):
        assert cut_record(b"a\tb\tc", [(2, 2)], "fields", "\t", False, False,
                          None, False, None) == b"b"

    def test_field_order_is_file_order(self):
        assert cut_record(b"a\tb\tc", [(3, 3), (1, 1)], "fields", "\t", False,
                          False, None, False, None) == b"a\tc"

    def test_open_field_range(self):
        assert cut_record(b"a\tb\tc\td", [(2, OPEN_END)], "fields", "\t",
                          False, False, None, False, None) == b"b\tc\td"

    def test_no_delimiter_passthrough(self):
        assert cut_record(b"nodelim", [(2, 2)], "fields", "\t", False, False,
                          None, False, None) == b"nodelim"

    def test_custom_delimiter(self):
        assert cut_record(b"root:x:0", [(1, 1)], "fields", ":", False, False,
                          None, False, None) == b"root"

    def test_complement(self):
        assert cut_record(b"a\tb\tc", [(2, 2)], "fields", "\t", True, False,
                          None, False, None) == b"a\tc"


class TestSplitRecords:

    def test_drops_trailing_empty(self):
        assert split_records(b"a\nb\n", False) == [b"a", b"b"]

    def test_keeps_final_without_newline(self):
        assert split_records(b"a\nb", False) == [b"a", b"b"]

    def test_zero_terminated(self):
        assert split_records(b"a\x00b\x00", True) == [b"a", b"b"]
