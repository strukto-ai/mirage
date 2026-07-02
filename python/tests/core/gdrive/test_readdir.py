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
from mirage.core.gdrive.readdir import readdir
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


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    files = [
        {
            "id": "f1",
            "name": "readme.txt",
            "mimeType": "text/plain",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{
                "me": True,
                "emailAddress": "me@gmail.com"
            }],
            "capabilities": {
                "canEdit": True
            },
        },
    ]
    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
        assert "/readme.txt" in result


@pytest.mark.asyncio
async def test_readdir_cached(accessor, index):
    entry = IndexEntry(
        id="f1",
        name="cached.txt",
        resource_type="gdrive/file",
        remote_time="2026-04-01T00:00:00.000Z",
        vfs_name="cached.txt",
    )
    await index.set_dir("/", [("cached.txt", entry)])
    result = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert any("cached.txt" in r for r in result)


@pytest.mark.asyncio
async def test_readdir_subfolder(accessor, index):
    await index.put(
        "/docs",
        IndexEntry(
            id="folder1",
            name="docs",
            resource_type="gdrive/folder",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="docs",
        ))

    files = [
        {
            "id": "f2",
            "name": "notes.txt",
            "mimeType": "text/plain",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [],
            "capabilities": {
                "canEdit": False
            },
        },
    ]
    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            return_value=files,
    ) as mock_list:
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/docs").strip("/"),
                     virtual="/docs",
                     directory="/docs"), index)
        assert "/docs/notes.txt" in result
        mock_list.assert_called_once_with(accessor.token_manager,
                                          folder_id="folder1",
                                          drive_id=None)


@pytest.mark.asyncio
async def test_readdir_repopulates_evicted_subfolder(accessor, index):
    root_files = [{
        "id": "folder1",
        "name": "docs",
        "mimeType": "application/vnd.google-apps.folder",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [],
        "capabilities": {},
    }]
    docs_files = [{
        "id": "f2",
        "name": "notes.txt",
        "mimeType": "text/plain",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [],
        "capabilities": {},
    }]

    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return root_files
        if folder_id == "folder1":
            return docs_files
        raise AssertionError(f"unexpected folder_id={folder_id}")

    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new=fake_list_files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/docs").strip("/"),
                     virtual="/docs",
                     directory="/docs"), index)
        assert "/docs/notes.txt" in result


@pytest.mark.asyncio
async def test_readdir_missing_subfolder_raises_after_recursion(
        accessor, index):
    root_files = [{
        "id": "f1",
        "name": "other.txt",
        "mimeType": "text/plain",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [],
        "capabilities": {},
    }]

    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return root_files
        raise AssertionError(f"should not list folder_id={folder_id}")

    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new=fake_list_files,
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(resource_path=("/docs").strip("/"),
                         virtual="/docs",
                         directory="/docs"), index)


@pytest.mark.asyncio
async def test_readdir_root_includes_shared_drives(accessor, index):
    files = [{
        "id": "f1",
        "name": "readme.txt",
        "mimeType": "text/plain",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [],
        "capabilities": {},
    }]
    drives = [{"id": "drive1", "name": "Team Drive"}]
    with patch("mirage.core.gdrive.readdir.list_files",
               new_callable=AsyncMock, return_value=files), \
         patch("mirage.core.gdrive.readdir.list_shared_drives",
               new_callable=AsyncMock, return_value=drives):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
        assert "/readme.txt" in result
        # Shared Drives appear as top-level directories.
        assert "/Team Drive/" in result
        # The drive id is carried on the cached entry for nested listings.
        entry = (await index.get("/Team Drive")).entry
        assert entry is not None
        assert entry.extra.get("drive_id") == "drive1"


@pytest.mark.asyncio
async def test_readdir_root_uniquifies_duplicate_shared_drive_names(
        accessor, index):
    drives = [
        {
            "id": "drive1",
            "name": "Team"
        },
        {
            "id": "drive2",
            "name": "Team"
        },
        {
            "id": "drive3",
            "name": "Team"
        },
    ]
    with patch("mirage.core.gdrive.readdir.list_files",
               new_callable=AsyncMock, return_value=[]), \
         patch("mirage.core.gdrive.readdir.list_shared_drives",
               new_callable=AsyncMock, return_value=drives):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)

    assert result == [
        "/Team/",
        "/Team [Shared Drive]/",
        "/Team [Shared Drive 2]/",
    ]
    assert (await index.get("/Team")).entry.id == "drive1"
    assert (await index.get("/Team [Shared Drive]")).entry.id == "drive2"
    assert (await index.get("/Team [Shared Drive 2]")).entry.id == "drive3"


@pytest.mark.asyncio
async def test_readdir_root_shared_drives_best_effort(accessor, index):
    """If Shared Drive enumeration fails, My Drive listing still succeeds."""
    files = [{
        "id": "f1",
        "name": "readme.txt",
        "mimeType": "text/plain",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [],
        "capabilities": {},
    }]
    with patch("mirage.core.gdrive.readdir.list_files",
               new_callable=AsyncMock, return_value=files), \
         patch("mirage.core.gdrive.readdir.list_shared_drives",
               new_callable=AsyncMock, side_effect=RuntimeError("no scope")):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
        assert "/readme.txt" in result


@pytest.mark.asyncio
async def test_readdir_workspace_files_get_extensions(accessor, index):
    files = [
        {
            "id": "d1",
            "name": "My Document",
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{
                "me": True,
                "emailAddress": "me@gmail.com"
            }],
            "capabilities": {
                "canEdit": True
            },
        },
        {
            "id": "s1",
            "name": "My Sheet",
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [],
            "capabilities": {
                "canEdit": False
            },
        },
        {
            "id": "p1",
            "name": "My Slides",
            "mimeType": "application/vnd.google-apps.presentation",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [],
            "capabilities": {},
        },
    ]
    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
        assert "/My Document.gdoc.json" in result
        assert "/My Sheet.gsheet.json" in result
        assert "/My Slides.gslide.json" in result
