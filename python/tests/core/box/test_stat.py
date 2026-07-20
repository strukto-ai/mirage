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
