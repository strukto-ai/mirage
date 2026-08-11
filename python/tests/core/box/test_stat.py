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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.config import IndexEntry
from mirage.core.box.read import read
from mirage.core.box.readdir import readdir
from mirage.core.box.stat import stat
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_stat_root_fetches_folder_info(accessor, index):
    with patch(
            "mirage.core.box.stat.get_folder_info",
            new_callable=AsyncMock,
            return_value={
                "id": "0",
                "modified_at": "2026-04-01T00:00:00+00:00"
            },
    ) as mock_info:
        info = await stat(
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)
    assert info.type == FileType.DIRECTORY
    assert info.name == "/"
    assert info.modified == "2026-04-01T00:00:00+00:00"
    mock_info.assert_awaited_once_with(accessor.token_manager, "0")


@pytest.mark.asyncio
async def test_stat_file_carries_box_metadata(accessor, index):
    await index.put(
        "/a.txt",
        IndexEntry(id="200",
                   name="a.txt",
                   resource_type="box/file",
                   remote_time="2026-04-01T00:00:00+00:00",
                   vfs_name="a.txt",
                   size=5))
    info = await stat(
        accessor,
        PathSpec(resource_path="a.txt", virtual="/a.txt", directory="/"),
        index)
    assert info.type == FileType.TEXT
    assert info.size == 5
    assert info.modified == "2026-04-01T00:00:00+00:00"
    assert info.fingerprint == "2026-04-01T00:00:00+00:00"
    assert info.extra["box_id"] == "200"
    assert info.extra["resource_type"] == "box/file"


@pytest.mark.asyncio
async def test_stat_folder_is_directory(accessor, index):
    await index.put(
        "/docs",
        IndexEntry(id="100",
                   name="docs",
                   resource_type="box/folder",
                   remote_time="2026-04-01T00:00:00+00:00",
                   vfs_name="docs"))
    info = await stat(
        accessor, PathSpec(resource_path="docs",
                           virtual="/docs",
                           directory="/"), index)
    assert info.type == FileType.DIRECTORY
    assert info.extra["box_id"] == "100"


@pytest.mark.asyncio
async def test_stat_populates_via_parent_readdir(accessor, index):
    items = [{
        "id": "200",
        "name": "a.txt",
        "type": "file",
        "size": 5,
        "modified_at": "2026-04-01T00:00:00+00:00",
    }]
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=items,
    ):
        info = await stat(
            accessor,
            PathSpec(resource_path="a.txt", virtual="/a.txt", directory="/"),
            index)
    assert info.size == 5


@pytest.mark.asyncio
async def test_stat_missing_raises(accessor, index):
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=[],
    ), patch(
            "mirage.core.box.resolve.list_folder_items",
            new_callable=AsyncMock,
            return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path="ghost",
                         virtual="/ghost",
                         directory="/"), index)


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(accessor, index):
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included; weblinks never appear at all.
    contents = {
        "200": b"hello",
        "201": b"",
        "400": b"abc",
    }
    tree = {
        "0": [
            {
                "id": "100",
                "name": "docs",
                "type": "folder",
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
            {
                "id": "200",
                "name": "a.txt",
                "type": "file",
                "size": 5,
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
            {
                "id": "201",
                "name": "empty.txt",
                "type": "file",
                "size": 0,
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
            {
                "id": "300",
                "name": "homepage",
                "type": "web_link",
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
        ],
        "100": [{
            "id": "400",
            "name": "b.bin",
            "type": "file",
            "size": 3,
            "modified_at": "2026-04-01T00:00:00+00:00",
        }],
    }

    async def _list(_tm, folder_id):
        return tree[folder_id]

    async def _download(_tm, file_id, _range=None):
        return contents[file_id]

    files: list[str] = []
    with patch("mirage.core.box.readdir.list_folder_items",
               side_effect=_list), \
         patch("mirage.core.box.read.download_file",
               side_effect=_download):
        stack = ["/"]
        while stack:
            current = stack.pop()
            listing = await readdir(accessor, PathSpec.from_str_path(current),
                                    index)
            for child in listing:
                trimmed = child.rstrip("/")
                info = await stat(accessor, PathSpec.from_str_path(trimmed),
                                  index)
                if info.type == FileType.DIRECTORY:
                    stack.append(trimmed)
                    continue
                assert info.size is not None, trimmed
                body = await read(accessor, PathSpec.from_str_path(trimmed),
                                  index)
                assert info.size == len(body), trimmed
                files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


@pytest.mark.asyncio
async def test_stat_direct_resolve_hides_weblinks(accessor, index):
    # Weblinks are filtered from listings; the resolve_item fallback must
    # not resurface one as a sizeless, unreadable entry.
    weblink = {
        "id": "300",
        "name": "homepage",
        "type": "web_link",
        "modified_at": "2026-04-01T00:00:00+00:00",
    }
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=[weblink],
    ), patch(
            "mirage.core.box.resolve.list_folder_items",
            new_callable=AsyncMock,
            return_value=[weblink],
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path="homepage",
                         virtual="/homepage",
                         directory="/"), index)
