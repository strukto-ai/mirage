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

from mirage.runtime.handles.constants import READ_CHUNK
from mirage.runtime.handles.file_handle import FileHandle, write_runs
from mirage.runtime.handles.types import FlushStep


def _over(data: bytes, calls: list[tuple[int, int | None]] | None = None):
    def fetch(offset: int, size: int | None) -> bytes:
        if calls is not None:
            calls.append((offset, size))
        return data[offset:] if size is None else data[offset : offset + size]

    return fetch


def _handle(
    data: bytes, *, writable: bool = True, append: bool = False
) -> FileHandle:
    return FileHandle.opened(
        "/f", _over(data), size=len(data), writable=writable, append=append
    )


def test_open_reads_nothing_and_a_small_file_is_fetched_whole():
    calls: list[tuple[int, int | None]] = []
    h = FileHandle.opened(
        "/f", _over(b"hello", calls), size=5, writable=False, append=False
    )
    assert calls == []
    assert h.read(2) == b"he"
    assert h.read() == b"llo"
    assert calls == [(0, None)]


def test_a_large_file_is_fetched_a_chunk_at_a_time():
    calls: list[tuple[int, int | None]] = []
    data = b"x" * (READ_CHUNK + 10)
    h = FileHandle.opened(
        "/f", _over(data, calls), size=len(data), writable=False, append=False
    )
    h.seek(READ_CHUNK + 5, 0)
    assert h.read(3) == b"xxx"
    assert calls == [(READ_CHUNK + 5, READ_CHUNK)]


def test_append_mode_starts_at_the_end_and_always_writes_there():
    h = _handle(b"abc", append=True)
    assert h.pos == 3
    h.seek(0, 0)
    h.write(b"XY")
    assert h.pread(0, 9) == b"abcXY"
    assert h.flush_plan() == [FlushStep("append", data=b"XY")]


def test_an_edit_owes_only_its_range():
    h = _handle(b"0123456789")
    h.seek(5, 0)
    h.write(b"BB")
    assert h.pread(0, 10) == b"01234BB789"
    assert h.flush_plan() == [FlushStep("pwrite", data=b"BB", offset=5)]


def test_writes_join_the_ranges_they_touch_and_a_later_write_wins():
    h = _handle(b"0123456789")
    h.pwrite(6, b"x")
    h.pwrite(1, b"ab")
    h.pwrite(2, b"CDEF")
    assert h.runs == [(1, bytearray(b"aCDEFx"))]
    assert h.pread(0, 10) == b"0aCDEFx789"


def test_a_write_past_the_end_reads_its_gap_as_zeros():
    h = _handle(b"ab")
    h.pwrite(4, b"Z")
    assert h.size == 5
    assert h.pread(0, 9) == b"ab\0\0Z"
    assert h.flush_plan() == [FlushStep("pwrite", data=b"Z", offset=4)]


def test_extending_the_end_goes_as_an_append():
    h = _handle(b"abc")
    h.seek(0, 2)
    h.write(b"de")
    assert h.flush_plan() == [FlushStep("append", data=b"de")]


def test_a_created_file_sends_only_its_ranges():
    h = FileHandle.opened("/f", None, size=0, writable=True, append=False)
    h.write(b"new")
    h.pwrite(5, b"!")
    assert h.flush_plan() == [
        FlushStep("pwrite", data=b"new", offset=0),
        FlushStep("pwrite", data=b"!", offset=5),
    ]


def test_truncate_cuts_then_ranges_then_growth():
    h = _handle(b"0123456789")
    h.pwrite(8, b"xy")
    h.truncate(4)
    assert h.runs == []
    assert h.pread(0, 10) == b"0123"
    h.pwrite(6, b"Q")
    h.truncate(9)
    assert h.pread(0, 10) == b"0123\0\0Q\0\0"
    assert h.flush_plan() == [
        FlushStep("truncate", length=4),
        FlushStep("pwrite", data=b"Q", offset=6),
        FlushStep("truncate", length=9),
    ]


def test_a_clean_handle_owes_nothing():
    h = _handle(b"abc")
    h.read()
    assert not h.dirty
    assert h.flush_plan() == []


def test_seek_answers_none_for_a_bad_whence_or_a_negative_target():
    h = _handle(b"hello", writable=False)
    assert h.seek(-2, 2) == 3
    assert h.seek(-9, 0) is None
    assert h.seek(0, 7) is None
    assert h.pos == 3


def test_eof_finds_the_end_of_a_file_whose_size_was_unknown():
    h = FileHandle.opened(
        "/f", _over(b"abc"), size=0, writable=False, append=False
    )
    assert not h.eof
    assert h.read() == b"abc"
    assert h.eof


def test_of_bytes_reads_what_it_was_given():
    h = FileHandle.of_bytes("", b"in")
    assert h.read() == b"in"
    assert h.eof and not h.writable


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
