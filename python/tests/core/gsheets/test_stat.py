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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gsheets.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gsheets", "/gsheets"),
                 virtual="/gsheets",
                 directory="/gsheets"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_owned_dir(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gsheets/owned", "/gsheets"),
                 virtual="/gsheets/owned",
                 directory="/gsheets/owned"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "owned"


@pytest.mark.asyncio
async def test_stat_sheet_from_cache(accessor, index):
    await index.set_dir("/gsheets/owned", [
        ("2026-04-01_My_Sheet__s1.gsheet.json",
         IndexEntry(id="s1",
                    name="My Sheet",
                    resource_type="gsheets/file",
                    remote_time="2026-04-01T00:00:00.000Z",
                    vfs_name="2026-04-01_My_Sheet__s1.gsheet.json",
                    size=512)),
    ])
    target = "/gsheets/owned/2026-04-01_My_Sheet__s1.gsheet.json"
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key(target, "/gsheets"),
                 virtual=target,
                 directory=target),
        index,
    )
    assert result.type == FileType.JSON
    assert result.extra["doc_id"] == "s1"


@pytest.mark.asyncio
async def test_stat_cache_miss_falls_back_via_readdir(accessor, index):
    files = [{
        "id": "s1",
        "name": "My Sheet",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "size": "512",
        "owners": [{
            "me": True
        }],
    }]
    target = "/gsheets/owned/2026-04-01_My_Sheet__s1.gsheet.json"
    with patch(
            "mirage.core.gsheets.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ) as mock_list:
        result = await stat(
            accessor,
            PathSpec(resource_path=mount_key(target, "/gsheets"),
                     virtual=target,
                     directory=target), index)
    assert result.type == FileType.JSON
    assert result.extra["doc_id"] == "s1"
    assert mock_list.call_count == 1


@pytest.mark.asyncio
async def test_stat_not_found_after_fallback(accessor, index):
    files = [{
        "id": "s1",
        "name": "Other",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [{
            "me": True
        }],
    }]
    with patch(
            "mirage.core.gsheets.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path=mount_key(
                    "/gsheets/owned/nope.gsheet.json", "/gsheets"),
                         virtual="/gsheets/owned/nope.gsheet.json",
                         directory="/gsheets/owned/nope.gsheet.json"), index)


@pytest.mark.asyncio
async def test_stat_index_none_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned/x.gsheet.json",
                                             "/gsheets"),
                     virtual="/gsheets/owned/x.gsheet.json",
                     directory="/gsheets/owned/x.gsheet.json"), None)
