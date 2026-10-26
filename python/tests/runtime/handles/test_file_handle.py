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

from mirage.runtime.handles.file_handle import overlaid, write_runs


def test_write_runs_fold_a_sequential_stream_into_one():
    assert write_runs([(0, b"ab"), (2, b"cd"), (4, b"e")]) == [(0, b"abcde")]
    assert write_runs([(0, b"new"), (1, b"O")]) == [(0, b"nOw")]
    assert write_runs([]) == []


def test_write_runs_keep_scattered_writes_apart_and_in_order():
    assert write_runs([(0, b"a"), (10, b"b")]) == [(0, b"a"), (10, b"b")]
    assert write_runs([(4, b"xy"), (0, b"abcdef")]) == [
        (4, b"xy"),
        (0, b"abcdef"),
    ]


def test_overlaid_lays_writes_over_the_stored_window_in_arrival_order():
    writes = [(1, b"XY"), (2, b"Z")]
    assert overlaid(b"abcd", 0, 4, writes) == b"aXZd"
    assert overlaid(b"cd", 2, 2, writes) == b"Zd"


def test_overlaid_grows_the_file_and_reads_a_gap_as_zeros():
    assert overlaid(b"ab", 0, 10, [(4, b"Q")]) == b"ab\x00\x00Q"
    assert overlaid(b"", 8, 4, [(4, b"Q")]) == b""
