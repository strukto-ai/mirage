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

from unittest.mock import patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.stream import stream
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import PathSpec


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
    return RAMIndexCacheStore()


async def _fake_download_stream(*args, **kwargs):
    yield b"chunk1"
    yield b"chunk2"


async def _collect(source):
    data = b""
    async for chunk in source:
        data += chunk
    return data


@pytest.mark.asyncio
async def test_stream_file(accessor, index):
    await index.put(
        "/data/report.pdf",
        IndexEntry(
            id="file123",
            name="report",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="report.pdf",
        ))
    with patch(
            "mirage.core.gdrive.stream.download_file_stream",
            side_effect=_fake_download_stream,
    ):
        data = await _collect(
            stream(
                accessor,
                PathSpec(original="/data/report.pdf",
                         directory="/data/report.pdf"), index))
        assert data == b"chunk1chunk2"


@pytest.mark.asyncio
async def test_stream_not_found(accessor, index):

    async def fake_list_files(_tm, folder_id):
        return []

    with patch("mirage.core.gdrive.readdir.list_files", new=fake_list_files):
        with pytest.raises(FileNotFoundError):
            await _collect(
                stream(
                    accessor,
                    PathSpec(original="/missing/file.txt",
                             directory="/missing/file.txt"), index))


@pytest.mark.asyncio
async def test_stream_auto_bootstraps_from_empty_index(accessor, index):

    async def fake_list_files(_tm, folder_id):
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
                "mirage.core.gdrive.stream.download_file_stream",
                side_effect=_fake_download_stream,
            ),
    ):
        data = await _collect(
            stream(
                accessor,
                PathSpec(original="/report.pdf", directory="/report.pdf"),
                index,
            ))
        assert data == b"chunk1chunk2"


@pytest.mark.asyncio
async def test_stream_folder_raises(accessor, index):
    await index.put(
        "/data",
        IndexEntry(
            id="folder1",
            name="data",
            resource_type="gdrive/folder",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="data",
        ))
    with pytest.raises(IsADirectoryError):
        await _collect(
            stream(accessor, PathSpec(original="/data", directory="/data"),
                   index))
