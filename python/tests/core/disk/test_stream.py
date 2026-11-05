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

import asyncio
import builtins

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk import stream
from mirage.core.disk.stream import read_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_stream_file(tmp_path):
    (tmp_path / "data.txt").write_bytes(b"stream content")
    accessor = DiskAccessor(tmp_path)
    chunks = []
    async for chunk in read_stream(
        accessor,
        PathSpec(
            vfs_path="data.txt", virtual="/data.txt", directory="/data.txt"
        ),
    ):
        chunks.append(chunk)
    assert b"".join(chunks) == b"stream content"


@pytest.mark.asyncio
async def test_stream_with_glob_scope(tmp_path):
    (tmp_path / "data.txt").write_bytes(b"abc")
    accessor = DiskAccessor(tmp_path)
    scope = PathSpec(
        vfs_path=mount_key("/disk/data.txt", "/disk"),
        virtual="/disk/data.txt",
        directory="/disk/",
    )
    chunks = []
    async for chunk in read_stream(accessor, scope):
        chunks.append(chunk)
    assert b"".join(chunks) == b"abc"


# A path under a plain file is ENOTDIR on the real filesystem, and the
# error names the virtual path, never the host one the mount resolves to.
@pytest.mark.asyncio
async def test_read_stream_under_a_plain_file_is_not_a_directory(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    spec = PathSpec(
        vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt/"
    )
    with pytest.raises(NotADirectoryError) as exc:
        [c async for c in read_stream(DiskAccessor(tmp_path), spec)]
    assert exc.value.filename == "/a.txt/x"
    assert str(tmp_path) not in str(exc.value)


def _spec(name: str) -> PathSpec:
    return PathSpec(vfs_path=name, virtual=f"/{name}", directory=f"/{name}")


@pytest.mark.asyncio
async def test_a_small_file_reads_in_one_trip_off_the_loop(
    tmp_path, monkeypatch
):
    (tmp_path / "a.txt").write_bytes(b"small")
    trips = []
    real = asyncio.to_thread

    async def counted(fn, *args, **kwargs):
        trips.append(fn)
        return await real(fn, *args, **kwargs)

    monkeypatch.setattr(stream.asyncio, "to_thread", counted)
    chunks = [
        chunk
        async for chunk in read_stream(DiskAccessor(tmp_path), _spec("a.txt"))
    ]
    assert chunks == [b"small"]
    assert len(trips) == 1


@pytest.mark.asyncio
async def test_a_file_past_one_chunk_streams_and_closes_when_left(
    tmp_path, monkeypatch
):
    (tmp_path / "a.txt").write_bytes(b"0123456789")
    accessor = DiskAccessor(tmp_path)
    assert [
        chunk
        async for chunk in read_stream(accessor, _spec("a.txt"), chunk_size=4)
    ] == [b"0123", b"4567", b"89"]
    opened = []

    def recording(*args, **kwargs):
        handle = builtins.open(*args, **kwargs)
        opened.append(handle)
        return handle

    monkeypatch.setattr(stream, "open", recording, raising=False)
    chunks = read_stream(accessor, _spec("a.txt"), chunk_size=4)
    assert await anext(chunks) == b"0123"
    await chunks.aclose()
    assert len(opened) == 1
    assert opened[0].closed
