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

from mirage.runtime.handles import (NO_WRITE, FileHandle, FileTable,
                                    merge_writes, parse_mode, plan_flush)


def test_plan_flush_sends_a_tail_when_the_handle_only_extended():
    assert plan_flush(3, 3, b"abcXYZ") == ("append", b"XYZ")


def test_plan_flush_sends_the_whole_file_when_history_was_rewritten():
    assert plan_flush(3, 0, b"ZZZdef") == ("write", b"ZZZdef")


def test_plan_flush_sends_the_whole_file_for_a_new_one():
    # base_len 0 means create or truncate: there is nothing to extend,
    # and the mount may not have the file at all yet.
    assert plan_flush(0, 0, b"fresh") == ("write", b"fresh")


def test_plan_flush_sends_the_whole_file_when_the_buffer_shrank():
    assert plan_flush(6, 6, b"abc") == ("write", b"abc")


def test_parse_mode_reads_the_five_facts():
    read = parse_mode("r")
    assert not read.writable and not read.create
    update = parse_mode("r+b")
    assert update.writable and not update.truncate and not update.create
    write = parse_mode("w")
    assert write.writable and write.truncate and write.create
    append = parse_mode("a")
    assert append.writable and append.append and not append.truncate
    exclusive = parse_mode("x")
    assert exclusive.writable and exclusive.exclusive and exclusive.create


def test_opened_positions_by_append_and_seeds_the_flush_facts():
    h = FileHandle.opened("/f", b"abc", writable=True, append=True)
    assert (h.pos, h.base_len, h.low_write, h.dirty) == (3, 3, NO_WRITE, False)
    fresh = FileHandle.opened("/f", b"abc", writable=False, append=False)
    assert fresh.pos == 0 and not fresh.writable


def test_read_advances_and_never_moves_backward():
    h = FileHandle.opened("/f", b"hello", writable=False, append=False)
    assert h.read(2) == b"he"
    assert h.read() == b"llo"
    h.pos = 99
    assert h.read(4) == b""
    assert h.pos == 99


def test_pread_leaves_the_position_alone():
    h = FileHandle.opened("/f", b"hello", writable=False, append=False)
    assert h.pread(1, 3) == b"ell"
    assert h.pos == 0


def test_write_extends_zero_fills_and_tracks_the_flush_facts():
    h = FileHandle.opened("/f", b"abc", writable=True, append=True)
    h.write(b"XY")
    assert bytes(h.buf) == b"abcXY" and h.dirty
    h.pwrite(7, b"Z")
    assert bytes(h.buf) == b"abcXY\0\0Z"
    assert h.low_write == 3
    assert h.flush_plan() == ("append", b"XY\0\0Z")
    h.pwrite(0, b"q")
    assert h.flush_plan()[0] == "write"


def test_seek_answers_none_for_a_bad_whence_or_a_negative_target():
    h = FileHandle.opened("/f", b"hello", writable=False, append=False)
    assert h.seek(-2, 2) == 3
    assert h.seek(-9, 0) is None
    assert h.seek(0, 7) is None
    assert h.pos == 3


def test_truncate_rewrites_history_in_both_directions():
    h = FileHandle.opened("/f", b"hello", writable=True, append=True)
    h.truncate(2)
    assert bytes(h.buf) == b"he" and h.low_write == 0 and h.dirty
    h.truncate(4)
    assert bytes(h.buf) == b"he\0\0"
    assert h.flush_plan()[0] == "write"


def test_eof_tracks_the_position():
    h = FileHandle.opened("/f", b"ab", writable=False, append=False)
    assert not h.eof
    h.read()
    assert h.eof


def test_merge_writes_splices_pads_and_keeps_arrival_order():
    assert merge_writes(b"hello", [(1, b"XY")]) == b"hXYlo"
    assert merge_writes(b"ab", [(4, b"z")]) == b"ab\0\0z"
    assert merge_writes(b"", [(0, b"new"), (1, b"O")]) == b"nOw"


def test_table_hands_out_dense_ids_from_first_id():
    table: FileTable[str] = FileTable(first_id=4)
    assert table.add("a") == 4
    assert table.add("b") == 5
    assert table.get(4) == "a"
    assert 5 in table and 9 not in table


def test_table_set_and_pop_move_entries_without_burning_ids():
    table: FileTable[str] = FileTable()
    fd = table.add("a")
    table.set(0, "seeded")
    assert table.pop(fd) == "a"
    assert table.pop(fd) is None
    assert table.get(0) == "seeded"
    assert list(table.values()) == ["seeded"]
