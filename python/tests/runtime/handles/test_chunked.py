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

from mirage.runtime.handles import ChunkedHandle

DATA = b"0123456789"


def _handle(monkeypatch, data: bytes = DATA, size: int = len(DATA)):
    monkeypatch.setattr("mirage.runtime.handles.chunked.READ_CHUNK", 4)
    fetched: list[tuple[int, int]] = []

    def fetch(offset: int, length: int) -> bytes:
        fetched.append((offset, length))
        return data[offset : offset + length]

    return ChunkedHandle(path="/f", size=size, fetch=fetch), fetched


def _read_all(handle: ChunkedHandle) -> bytes:
    out, offset = b"", 0
    while chunk := handle.pread(offset, 4):
        out += chunk
        offset += len(chunk)
    return out


def test_small_reads_cost_one_fetch_per_chunk(monkeypatch):
    # A guest reads in small pieces; each would otherwise be a request.
    handle, fetched = _handle(monkeypatch)
    assert fetched == []
    spans = [(0, 1), (1, 2), (3, 1), (4, 3), (7, 4), (10, 4)]
    reads = [handle.pread(offset, size) for offset, size in spans]
    assert reads == [b"0", b"12", b"3", b"456", b"789", b""]
    assert fetched == [(0, 4), (4, 4), (7, 4)]


@pytest.mark.parametrize("data, size", [(DATA, 6), (b"01", 10)])
def test_the_file_ends_where_a_fetch_comes_back_short(monkeypatch, data, size):
    # A rendering need not be as long as the stored bytes a stat
    # measured, so the size the open saw neither cuts a read short nor
    # pads it.
    handle, _ = _handle(monkeypatch, data, size)
    assert _read_all(handle) == data
    assert handle.size == len(data)


def test_an_empty_read_past_the_end_keeps_the_size(monkeypatch):
    # A read past the end finds nothing, which does not put the end
    # there: the size, and a write after it, stay at 3.
    handle, _ = _handle(monkeypatch, b"abc", 3)
    assert handle.pread(100, 4) == b""
    assert handle.size == 3


def test_pread_and_drop(monkeypatch):
    handle, fetched = _handle(monkeypatch)
    assert handle.pread(8, 5) == b"89" and handle.pread(8, 4) == b"89"
    handle.drop()
    assert handle.pread(8, 1) == b"8"
    assert fetched == [(8, 5), (8, 4)]
