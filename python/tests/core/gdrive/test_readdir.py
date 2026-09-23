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
from fakeredis.aioredis import FakeRedis

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import TokenManager
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
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("change", ["updated", "deleted", "renamed-folder"])
async def test_direct_stat_after_invalidation_refreshes_ids(
        accessor, backend, change, monkeypatch):
    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    refreshed = False
    calls = []

    async def list_files(_tm, folder_id="root", **kwargs):
        calls.append(folder_id)
        if folder_id == "root":
            if refreshed and change == "renamed-folder" and kwargs.get(
                    "name") == "docs":
                return []
            return [{
                "id": "new-folder",
                "name": "renamed" if change == "renamed-folder" else "docs",
                "mimeType": "application/vnd.google-apps.folder"
            }] if refreshed else [
                {
                    "id": "old-folder",
                    "name": "docs",
                    "mimeType": "application/vnd.google-apps.folder"
                }
            ]
        assert folder_id == ("new-folder" if refreshed else "old-folder")
        if refreshed and change == "deleted":
            return []
        return [{
            "id": "new-file" if refreshed else "old-file",
            "name": "report.pdf",
            "mimeType": "application/pdf",
            "size": "42" if refreshed else "3"
        }]

    monkeypatch.setattr("mirage.core.gdrive.readdir.list_files", list_files)
    monkeypatch.setattr("mirage.core.gdrive.resolve.list_files", list_files)
    monkeypatch.setattr("mirage.core.gdrive.readdir.list_shared_drives",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.gdrive.resolve.list_shared_drives",
                        AsyncMock(return_value=[]))
    try:
        await readdir(accessor, PathSpec.from_str_path("/drive/docs", "docs"),
                      index)
        await index.invalidate()
        refreshed = True
        calls.clear()
        path = PathSpec.from_str_path("/drive/docs/report.pdf",
                                      "docs/report.pdf")
        if change == "updated":
            result = await stat(accessor, path, index)
            assert result.extra["file_id"] == "new-file"
            assert result.size == 42
        else:
            with pytest.raises(FileNotFoundError):
                await stat(accessor, path, index)
        assert calls[0] == "root"
        assert "old-folder" not in calls
    finally:
        await index.close()
        await client.aclose()


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
            accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index)
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
    result = await readdir(accessor,
                           PathSpec(vfs_path="", virtual="/", directory="/"),
                           index)
    assert any("cached.txt" in r for r in result)


@pytest.mark.asyncio
async def test_readdir_subfolder(accessor, index):
    await index.set_dir('/', [('docs',
                               IndexEntry(
                                   id="folder1",
                                   name="docs",
                                   resource_type="gdrive/folder",
                                   remote_time="2026-04-01T00:00:00.000Z",
                                   vfs_name="docs",
                               ))])

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
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            index)
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
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            index)
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
                PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
                index)


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_not_a_directory(accessor, index):
    # Listing a file's own id answers with an empty child set rather than
    # an error, so the recursion below has to refuse at the file itself or
    # `/a.txt/x` comes back ENOENT where opendir(2) says ENOTDIR.
    root_files = [{
        "id": "f1",
        "name": "a.txt",
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
        with pytest.raises(NotADirectoryError):
            await readdir(
                accessor,
                PathSpec(vfs_path="a.txt/x",
                         virtual="/a.txt/x",
                         directory="/a.txt/x"), index)


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
            accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index)
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
            accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index)

    assert result == [
        "/Team/",
        "/Team [Shared Drive 2]/",
        "/Team [Shared Drive]/",
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
            accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index)
        assert "/readme.txt" in result


@pytest.mark.asyncio
async def test_readdir_failed_shared_drives_leaves_root_uncached(
        accessor, index):
    """A short root listing must not be cached as the directory.

    Caching it would keep the mount My-Drive-only until the entry expires,
    long after the cause (a missing scope) is fixed. The entries are real,
    so they stay cached; only the directory listing is withheld, so the
    next readdir retries enumeration and picks the Shared Drive up.
    """
    files = [{
        "id": "f1",
        "name": "readme.txt",
        "mimeType": "text/plain",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [],
        "capabilities": {},
    }]
    root = PathSpec(vfs_path="", virtual="/", directory="/")
    with patch("mirage.core.gdrive.readdir.list_files",
               new_callable=AsyncMock, return_value=files), \
         patch("mirage.core.gdrive.readdir.list_shared_drives",
               new_callable=AsyncMock, side_effect=RuntimeError("no scope")):
        await readdir(accessor, root, index)
    assert (await index.list_dir("/")).entries is None
    assert (await index.get("/readme.txt")).entry.id == "f1"

    drives = [{"id": "drive1", "name": "Team"}]
    with patch("mirage.core.gdrive.readdir.list_files",
               new_callable=AsyncMock, return_value=files), \
         patch("mirage.core.gdrive.readdir.list_shared_drives",
               new_callable=AsyncMock, return_value=drives):
        result = await readdir(accessor, root, index)
    assert "/Team/" in result
    assert (await index.list_dir("/")).entries is not None


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
            accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index)
        assert "/My Document.gdoc.json" in result
        assert "/My Sheet.gsheet.json" in result
        assert "/My Slides.gslide.json" in result


@pytest.mark.asyncio
async def test_readdir_size_binary_kept_google_apps_in_extra(accessor, index):
    files = [
        {
            "id": "f1",
            "name": "report.pdf",
            "mimeType": "application/pdf",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "size": "2048",
            "owners": [],
            "capabilities": {},
        },
        {
            "id": "d1",
            "name": "My Document",
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "quotaBytesUsed": "9999",
            "owners": [],
            "capabilities": {},
        },
    ]
    with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        await readdir(accessor,
                      PathSpec(vfs_path="", virtual="/", directory="/"), index)

    # Binary files download raw: Drive's size is the rendered byte length.
    binary = (await index.get("/report.pdf")).entry
    assert binary.size == 2048
    # Google-apps files render to JSON: Drive's source size must not
    # become the entry size, it lives in extra only.
    doc = (await index.get("/My Document.gdoc.json")).entry
    assert doc.size is None
    assert doc.extra["source_size"] == 9999


@pytest.mark.asyncio
async def test_readdir_scoped_mount_lists_folder_children(
        fake_drive, scoped_accessor):
    scope = fake_drive.folder("scope")
    fake_drive.add("in.txt", parent=scope, content=b"x")
    fake_drive.add("out.txt", content=b"y")
    accessor = scoped_accessor(scope)
    entries = await readdir(
        accessor,
        PathSpec(virtual="/", directory="/", vfs_path=""),
        index=NULL_INDEX,
    )
    assert entries == ["/in.txt"]
