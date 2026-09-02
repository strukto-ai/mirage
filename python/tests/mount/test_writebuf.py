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

from mirage.mount.writebuf import WriteBuffer


def _buffer() -> WriteBuffer:
    return WriteBuffer()


def _drain(buf: WriteBuffer, fileid: int, base: bytes = b"") -> bytes:
    return WriteBuffer.merge(base, buf.take(fileid))


def test_merge_applies_writes_at_their_offsets():
    assert WriteBuffer.merge(b"aaaa", [(1, b"bb")]) == b"abba"


def test_merge_extends_and_zero_fills_a_gap():
    assert WriteBuffer.merge(b"ab", [(4, b"z")]) == b"ab\x00\x00z"


def test_merge_applies_out_of_order_writes_by_offset():
    merged = WriteBuffer.merge(b"", [(4, b"dd"), (0, b"aa"), (2, b"bb")])
    assert merged == b"aabbdd"


def test_merge_lets_a_later_overlapping_write_win():
    assert WriteBuffer.merge(b"", [(0, b"aaaa"), (1, b"XX")]) == b"aXXa"


def test_pending_size_tracks_the_furthest_write():
    buf = _buffer()
    buf.append(1, 100, b"xyz")
    assert buf.pending_size(1, base_size=0) == 103


def test_pending_size_keeps_a_larger_base():
    buf = _buffer()
    buf.append(1, 0, b"x")
    assert buf.pending_size(1, base_size=500) == 500


def test_pending_size_is_the_base_when_nothing_is_buffered():
    buf = _buffer()
    assert buf.pending_size(1, base_size=42) == 42


def test_overlay_reads_through_pending_writes():
    buf = _buffer()
    buf.append(1, 0, b"new")
    assert buf.overlay(1, b"oldold", 0, 6) == b"newold"


def test_overlay_returns_the_base_slice_when_clean():
    buf = _buffer()
    assert buf.overlay(1, b"abcdef", 2, 3) == b"cde"


def test_take_drains_pending_writes():
    buf = _buffer()
    buf.append(1, 0, b"hello")
    assert _drain(buf, 1) == b"hello"
    assert not buf.has_pending(1)


def test_take_returns_nothing_when_clean():
    buf = _buffer()
    assert buf.take(1) == []


def test_drop_discards_without_flushing():
    buf = _buffer()
    buf.append(1, 0, b"doomed")
    buf.drop(1)
    assert buf.take(1) == []
    assert not buf.has_pending(1)


def test_clip_truncates_pending_writes_to_a_new_length():
    buf = _buffer()
    buf.append(1, 0, b"abcdef")
    buf.clip(1, 3)
    assert _drain(buf, 1) == b"abc"


def test_clip_to_zero_drops_every_pending_write():
    buf = _buffer()
    buf.append(1, 0, b"abcdef")
    buf.clip(1, 0)
    assert not buf.has_pending(1)


def test_append_reports_when_the_ceiling_is_reached():
    buf = _buffer()
    assert buf.append(1, 0, b"x" * 10, max_bytes=16) is False
    assert buf.append(1, 10, b"y" * 10, max_bytes=16) is True


def test_idle_ids_lists_only_handles_past_the_deadline():
    buf = _buffer()
    buf.append(1, 0, b"a", now=100.0)
    buf.append(2, 0, b"b", now=140.0)
    assert buf.idle_ids(older_than=30.0, now=150.0) == [1]


def test_pending_ids_lists_every_buffered_handle():
    buf = _buffer()
    buf.append(1, 0, b"a")
    buf.append(2, 0, b"b")
    assert sorted(buf.pending_ids()) == [1, 2]


def test_buffers_are_independent_per_handle():
    buf = _buffer()
    buf.append(1, 0, b"one")
    buf.append(2, 0, b"two")
    assert _drain(buf, 1) == b"one"
    assert buf.has_pending(2)


def test_overlay_reads_through_overlapping_writes():
    # The read path must resolve overlap exactly as the flush will:
    # a client that copies a file with overlapping WRITEs (observed
    # from the macOS client; corrupts nfsserve's own demo) reads back
    # inside the flush window and must see the final bytes.
    buf = _buffer()
    buf.append(7, 0, b"AAAAAA")
    buf.append(7, 3, b"BBB")
    buf.append(7, 5, b"CC")
    assert buf.overlay(7, b"0123456789", 0, 10) == b"AAABBCC789"


def test_clip_preserves_overlap_resolution():
    buf = _buffer()
    buf.append(7, 0, b"AAAAAA")
    buf.append(7, 4, b"BBBB")
    buf.clip(7, 6)
    assert WriteBuffer.merge(b"", buf.take(7)) == b"AAAABB"
