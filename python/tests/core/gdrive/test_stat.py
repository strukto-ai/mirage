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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.stat import stat
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import FileType, PathSpec


@pytest.fixture
def config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def token_manager(config):
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


@pytest.fixture
def accessor(config, token_manager):
    return GDriveAccessor(config=config, token_manager=token_manager)


@pytest.fixture
def index():
    store = RAMIndexCacheStore()
    return store


async def _populate_index(index):
    await index.put(
        "/report.pdf",
        IndexEntry(
            id="f1",
            name="report",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="report.pdf",
            size=1024,
        ))
    await index.put(
        "/docs",
        IndexEntry(
            id="folder1",
            name="docs",
            resource_type="gdrive/folder",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="docs",
        ))
    return index


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    idx = await _populate_index(index)
    result = await stat(accessor,
                        PathSpec(resource_path="", virtual="/", directory="/"),
                        idx)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_file(accessor, index):
    idx = await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(resource_path="report.pdf",
                 virtual="/report.pdf",
                 directory="/report.pdf"), idx)
    assert result.name == "report.pdf"
    assert result.size == 1024
    assert result.extra["file_id"] == "f1"
    assert result.extra["resource_type"] == "gdrive/file"


@pytest.mark.asyncio
async def test_stat_folder(accessor, index):
    idx = await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(resource_path="docs", virtual="/docs", directory="/docs"),
        idx)
    assert result.type == FileType.DIRECTORY
    assert result.extra["file_id"] == "folder1"


@pytest.mark.asyncio
async def test_stat_shared_drive_is_directory(accessor, index):
    await index.put(
        "/Team Drive",
        IndexEntry(
            id="drive1",
            name="Team Drive",
            resource_type="gdrive/shared_drive",
            vfs_name="Team Drive",
            extra={"drive_id": "drive1"},
        ))
    result = await stat(
        accessor,
        PathSpec(resource_path="Team Drive",
                 virtual="/Team Drive",
                 directory="/Team Drive"),
        index,
    )
    assert result.type == FileType.DIRECTORY
    assert result.extra["file_id"] == "drive1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    idx = await _populate_index(index)
    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path="nonexistent.txt",
                         virtual="/nonexistent.txt",
                         directory="/nonexistent.txt"), idx)


@pytest.mark.asyncio
async def test_stat_cache_miss_falls_back_via_readdir(accessor, index):
    files = [{
        "id": "f99",
        "name": "fresh.pdf",
        "mimeType": "application/pdf",
        "modifiedTime": "2026-04-15T00:00:00.000Z",
        "size": "2048",
    }]
    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            return_value=files,
    ) as mock_list:
        result = await stat(
            accessor,
            PathSpec(resource_path="fresh.pdf",
                     virtual="/fresh.pdf",
                     directory="/fresh.pdf"), index)
    assert result.name == "fresh.pdf"
    assert result.extra["file_id"] == "f99"
    # binary files download raw, so Drive's size is the rendered length
    assert result.size == 2048
    assert mock_list.call_count == 1


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure(accessor, index):
    failure = RuntimeError("drive unavailable")
    with patch("mirage.core.gdrive.stat._readdir",
               new_callable=AsyncMock,
               side_effect=failure):
        with pytest.raises(RuntimeError, match="drive unavailable"):
            await stat(accessor, PathSpec.from_str_path("/missing.txt"), index)
