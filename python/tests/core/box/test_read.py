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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.config import IndexEntry
from mirage.core.box.read import read, stream
from mirage.types import PathSpec


def _spec(virtual: str) -> PathSpec:
    return PathSpec(resource_path=virtual.strip("/"),
                    virtual=virtual,
                    directory=virtual)


@pytest.mark.asyncio
async def test_read_plain_file_downloads_by_id(accessor, index):
    await index.put(
        "/a.txt",
        IndexEntry(id="200",
                   name="a.txt",
                   resource_type="box/file",
                   vfs_name="a.txt"))
    with patch(
            "mirage.core.box.read.download_file",
            new_callable=AsyncMock,
            return_value=b"hello",
    ) as mock_dl:
        assert await read(accessor, _spec("/a.txt"), index) == b"hello"
    mock_dl.assert_awaited_once_with(accessor.token_manager, "200")


@pytest.mark.asyncio
async def test_read_box_native_file_returns_raw_bytes(accessor, index):
    await index.put(
        "/n.boxnote",
        IndexEntry(id="300",
                   name="n.boxnote",
                   resource_type="box/file",
                   vfs_name="n.boxnote"))
    raw = json.dumps({"doc": {"content": []}}).encode()
    with patch(
            "mirage.core.box.read.download_file",
            new_callable=AsyncMock,
            return_value=raw,
    ):
        out = await read(accessor, _spec("/n.boxnote"), index)
    assert out == raw


@pytest.mark.asyncio
async def test_read_folder_raises_eisdir(accessor, index):
    await index.put(
        "/docs",
        IndexEntry(id="100",
                   name="docs",
                   resource_type="box/folder",
                   vfs_name="docs"))
    with pytest.raises(IsADirectoryError):
        await read(accessor, _spec("/docs"), index)


@pytest.mark.asyncio
async def test_read_missing_populates_parent_then_raises(accessor, index):
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _spec("/ghost.txt"), index)


@pytest.mark.asyncio
async def test_stream_plain_file_chunks(accessor, index):
    await index.put(
        "/a.txt",
        IndexEntry(id="200",
                   name="a.txt",
                   resource_type="box/file",
                   vfs_name="a.txt"))

    async def fake_stream(_tm, _fid):
        yield b"he"
        yield b"llo"

    with patch("mirage.core.box.read.download_file_stream", new=fake_stream):
        chunks = [c async for c in stream(accessor, _spec("/a.txt"), index)]
    assert b"".join(chunks) == b"hello"
