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
from mirage.core.gdrive.read import read
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import PathSpec


async def fail_list_files(_tm, folder_id, drive_id=None):
    raise RuntimeError("drive unavailable")


async def empty_list_files(_tm, folder_id, drive_id=None):
    return []


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


@pytest.mark.asyncio
async def test_read_file(accessor, index):
    await index.put(
        "/Team Drive/report.pdf",
        IndexEntry(
            id="file123",
            name="report",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="report.pdf",
            extra={"drive_id": "drive1"},
        ))
    content = b"pdf content here"
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=content,
    ):
        result = await read(
            accessor,
            PathSpec(resource_path="Team Drive/report.pdf",
                     virtual="/Team Drive/report.pdf",
                     directory="/Team Drive/report.pdf"), index)
        assert result == content


@pytest.mark.asyncio
async def test_read_shared_drive_raises_is_a_directory(accessor, index):
    await index.put(
        "/Team Drive",
        IndexEntry(
            id="drive1",
            name="Team Drive",
            resource_type="gdrive/shared_drive",
            vfs_name="Team Drive",
            extra={"drive_id": "drive1"},
        ))
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
    ) as mock_download:
        with pytest.raises(IsADirectoryError):
            await read(
                accessor,
                PathSpec(resource_path="Team Drive",
                         virtual="/Team Drive",
                         directory="/Team Drive"),
                index,
            )
    mock_download.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_not_found(accessor, index):
    with patch("mirage.core.gdrive.readdir.list_files", new=empty_list_files):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(resource_path="missing/file.txt",
                         virtual="/missing/file.txt",
                         directory="/missing/file.txt"), index)


@pytest.mark.asyncio
async def test_read_auto_bootstraps_from_empty_index(accessor, index):

    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return [{
                "id": "f1",
                "name": "report.pdf",
                "mimeType": "application/pdf",
                "modifiedTime": "2026-04-01T00:00:00.000Z",
                "owners": [],
                "capabilities": {},
            }]
        raise AssertionError(f"unexpected folder_id={folder_id}")

    with (
            patch(
                "mirage.core.gdrive.readdir.list_files",
                new=fake_list_files,
            ),
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                return_value=b"pdf-bytes",
            ),
    ):
        result = await read(
            accessor,
            PathSpec(resource_path="report.pdf",
                     virtual="/report.pdf",
                     directory="/report.pdf"),
            index,
        )
        assert result == b"pdf-bytes"


@pytest.mark.asyncio
async def test_read_missing_file_raises_after_recursion(accessor, index):

    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return [{
                "id": "f1",
                "name": "other.txt",
                "mimeType": "text/plain",
                "modifiedTime": "2026-04-01T00:00:00.000Z",
                "owners": [],
                "capabilities": {},
            }]
        raise AssertionError(f"unexpected folder_id={folder_id}")

    with (
            patch(
                "mirage.core.gdrive.readdir.list_files",
                new=fake_list_files,
            ),
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                side_effect=AssertionError("should not call download_file"),
            ),
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(resource_path="missing.txt",
                         virtual="/missing.txt",
                         directory="/missing.txt"),
                index,
            )


@pytest.mark.asyncio
async def test_read_propagates_parent_refresh_failure(accessor, index):
    with patch("mirage.core.gdrive.readdir.list_files", new=fail_list_files):
        with pytest.raises(RuntimeError, match="drive unavailable"):
            await read(
                accessor,
                PathSpec(resource_path="missing.txt",
                         virtual="/missing.txt",
                         directory="/missing.txt"),
                index,
            )
