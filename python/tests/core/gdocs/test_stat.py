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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdocs.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gdocs", "/gdocs"),
                 virtual="/gdocs",
                 directory="/gdocs"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_owned_dir(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                 virtual="/gdocs/owned",
                 directory="/gdocs/owned"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "owned"


@pytest.mark.asyncio
async def test_stat_shared_dir(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gdocs/shared", "/gdocs"),
                 virtual="/gdocs/shared",
                 directory="/gdocs/shared"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "shared"


@pytest.mark.asyncio
async def test_stat_doc(accessor, index):
    await index.set_dir("/gdocs/owned", [
        ("2026-04-01_My_Doc__doc1.gdoc.json",
         IndexEntry(id="doc1",
                    name="My Doc",
                    resource_type="gdocs/file",
                    remote_time="2026-04-01T00:00:00.000Z",
                    vfs_name="2026-04-01_My_Doc__doc1.gdoc.json",
                    extra={"source_size": 1000})),
    ])
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key(
            "/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json", "/gdocs"),
                 virtual="/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json",
                 directory="/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json"),
        index,
    )
    assert result.name == "2026-04-01_My_Doc__doc1.gdoc.json"
    assert result.type == FileType.JSON
    assert result.modified == "2026-04-01T00:00:00.000Z"
    assert result.extra["doc_id"] == "doc1"
    assert result.extra["doc_name"] == "My Doc"
    # rendered JSON length is unknown until read; the Drive source size
    # is surfaced via extra only
    assert result.size is None
    assert result.extra["source_size"] == 1000


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    files = [{
        "id": "doc1",
        "name": "My Doc",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [{
            "me": True
        }],
    }]
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path=mount_key(
                    "/gdocs/owned/nonexistent.gdoc.json", "/gdocs"),
                         virtual="/gdocs/owned/nonexistent.gdoc.json",
                         directory="/gdocs/owned/nonexistent.gdoc.json"),
                index)


@pytest.mark.asyncio
async def test_stat_cache_miss_falls_back_via_readdir(accessor, index):
    files = [{
        "id": "doc1",
        "name": "My Doc",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "size": "1234",
        "owners": [{
            "me": True
        }],
    }]
    target = "/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json"
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ) as mock_list:
        result = await stat(
            accessor,
            PathSpec(resource_path=mount_key(target, "/gdocs"),
                     virtual=target,
                     directory=target), index)
    assert result.type == FileType.JSON
    assert result.extra["doc_id"] == "doc1"
    assert result.size is None
    assert result.extra["source_size"] == 1234
    assert mock_list.call_count == 1


@pytest.mark.asyncio
async def test_stat_cache_miss_with_index_none_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/doc.gdoc.json",
                                             "/gdocs"),
                     virtual="/gdocs/owned/doc.gdoc.json",
                     directory="/gdocs/owned/doc.gdoc.json"), None)
