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
from mirage.core.box.readdir import is_dir_name, readdir
from mirage.types import PathSpec


def test_is_dir_name_only_trusts_trailing_slash():
    assert is_dir_name("docs/") is True
    assert is_dir_name("docs") is None


@pytest.mark.asyncio
async def test_readdir_root_lists_folder_zero(accessor, index):
    items = [
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
    ]
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=items,
    ) as mock_list:
        result = await readdir(
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)
    assert result == ["/docs/", "/a.txt"]
    mock_list.assert_awaited_once_with(accessor.token_manager, "0")
    entry = (await index.get("/a.txt")).entry
    assert entry is not None
    assert entry.id == "200"
    assert entry.size == 5
    folder = (await index.get("/docs")).entry
    assert folder is not None
    assert folder.resource_type == "box/folder"
    assert folder.size is None


@pytest.mark.asyncio
async def test_readdir_box_native_files_surface_raw(accessor, index):
    items = [{
        "id": "300",
        "name": "meeting.boxnote",
        "type": "file",
        "size": 42,
        "modified_at": "2026-04-01T00:00:00+00:00",
    }]
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=items,
    ):
        result = await readdir(
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)
    assert result == ["/meeting.boxnote"]
    entry = (await index.get("/meeting.boxnote")).entry
    assert entry is not None
    assert entry.resource_type == "box/file"


@pytest.mark.asyncio
async def test_readdir_subfolder_resolves_id_via_index(accessor, index):
    await index.put(
        "/docs",
        IndexEntry(id="100",
                   name="docs",
                   resource_type="box/folder",
                   vfs_name="docs"))
    items = [{
        "id": "400",
        "name": "notes.txt",
        "type": "file",
        "size": 3,
        "modified_at": "2026-04-01T00:00:00+00:00",
    }]
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=items,
    ) as mock_list:
        result = await readdir(
            accessor,
            PathSpec(resource_path="docs", virtual="/docs", directory="/docs"),
            index)
    assert result == ["/docs/notes.txt"]
    mock_list.assert_awaited_once_with(accessor.token_manager, "100")


@pytest.mark.asyncio
async def test_readdir_repopulates_evicted_parent(accessor, index):
    root_items = [{
        "id": "100",
        "name": "docs",
        "type": "folder",
        "modified_at": "2026-04-01T00:00:00+00:00",
    }]
    docs_items = [{
        "id": "400",
        "name": "notes.txt",
        "type": "file",
        "size": 3,
        "modified_at": "2026-04-01T00:00:00+00:00",
    }]

    async def fake_list(_tm, folder_id, limit=1000):
        if folder_id == "0":
            return root_items
        if folder_id == "100":
            return docs_items
        raise AssertionError(f"unexpected folder_id={folder_id}")

    with patch("mirage.core.box.readdir.list_folder_items", new=fake_list):
        result = await readdir(
            accessor,
            PathSpec(resource_path="docs", virtual="/docs", directory="/docs"),
            index)
    assert result == ["/docs/notes.txt"]


@pytest.mark.asyncio
async def test_readdir_missing_folder_raises(accessor, index):
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(resource_path="ghost",
                         virtual="/ghost",
                         directory="/ghost"), index)


@pytest.mark.asyncio
async def test_readdir_serves_cached_listing_without_api_call(accessor, index):
    entry = IndexEntry(id="1",
                       name="cached.txt",
                       resource_type="box/file",
                       vfs_name="cached.txt")
    await index.set_dir("/", [("cached.txt", entry)])
    with patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
    ) as mock_list:
        result = await readdir(
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)
    assert any("cached.txt" in r for r in result)
    mock_list.assert_not_awaited()
