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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import DirListing, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.fixtures.gdrive_api import DriveCall, StubDrive, install_drive

ROOT = PathSpec(vfs_path="", virtual="/", directory="/")


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


def _rows(listed: list[FileStat] | DirListing) -> dict[str, FileStat]:
    rows = listed.entries if isinstance(listed, DirListing) else listed
    return {row.name: row for row in rows}


def _patched(monkeypatch, files, drives=()) -> DriveCall:
    """Serve ``list_files`` answering ``files`` and ``list_shared_drives``
    answering ``drives`` (an exception is raised instead), and hand back
    the lister.

    Args:
        monkeypatch (pytest.MonkeyPatch): the test's monkeypatch.
        files (list[dict] | DriveCall): the listing, or a lister.
        drives (Iterable[dict] | Exception): the shared drives.
    """
    shared = (
        AsyncMock(side_effect=drives)
        if isinstance(drives, Exception)
        else AsyncMock(return_value=list(drives))
    )
    lister = files if callable(files) else AsyncMock(return_value=files)
    install_drive(
        monkeypatch, StubDrive(list_files=lister, list_shared_drives=shared)
    )
    return lister


def _file(file_id: str, name: str, mime: str = "text/plain", **more) -> dict:
    return {
        "id": file_id,
        "name": name,
        "mimeType": mime,
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        **more,
    }


FOLDER = "application/vnd.google-apps.folder"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["updated", "deleted", "renamed-folder"])
async def test_a_stat_after_the_listings_drop_lists_the_ids_again(
    accessor, change, monkeypatch
):
    refreshed = False
    calls = []

    async def list_files(folder_id="root", **kwargs):
        calls.append(folder_id)
        if folder_id == "root":
            if not refreshed:
                return [_file("old-folder", "docs", FOLDER)]
            name = "renamed" if change == "renamed-folder" else "docs"
            return [_file("new-folder", name, FOLDER)]
        assert folder_id == ("new-folder" if refreshed else "old-folder")
        if refreshed and change == "deleted":
            return []
        return [
            _file(
                "new-file" if refreshed else "old-file",
                "report.pdf",
                "application/pdf",
                size="42" if refreshed else "3",
            )
        ]

    vfs = GoogleDriveVFS(
        config=GoogleDriveConfig(client_id="x", refresh_token="y")
    )
    vfs.accessor = accessor
    ws = Workspace({"/drive/": vfs}, mode=MountMode.READ)
    try:
        _patched(monkeypatch, list_files)
        await ws.dispatch("readdir", PathSpec.from_str_path("/drive/docs"))
        await ws.mount("/drive/").index_store.invalidate()
        refreshed = True
        calls.clear()
        path = PathSpec.from_str_path("/drive/docs/report.pdf")
        if change == "updated":
            result, _ = await ws.dispatch("stat", path)
            assert result.extra["file_id"] == "new-file"
            assert result.size == 42
        else:
            with pytest.raises(FileNotFoundError):
                await ws.dispatch("stat", path)
        assert calls[0] == "root"
        assert "old-folder" not in calls
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_readdir_root(accessor, monkeypatch):
    _patched(monkeypatch, [_file("f1", "readme.txt")])
    rows = _rows(await readdir(accessor, ROOT))
    assert rows["readme.txt"].extra["file_id"] == "f1"


@pytest.mark.asyncio
async def test_readdir_lists_a_folder_by_the_id_its_row_names(
    accessor, monkeypatch
):
    folder = FileStat(
        name="docs", type=FileType.DIRECTORY, extra={"file_id": "folder1"}
    )
    mock_list = _patched(monkeypatch, [_file("f2", "notes.txt")])
    rows = _rows(
        await readdir(
            accessor,
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            folder,
        )
    )
    mock_list.assert_called_once_with(folder_id="folder1", drive_id=None)
    assert list(rows) == ["notes.txt"]


@pytest.mark.asyncio
async def test_readdir_of_nothing_is_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            None,
        )


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_not_a_directory(accessor):
    # Listing a file's own id answers with an empty child set rather than
    # an error, so the row has to refuse at the file itself or `/a.txt/x`
    # comes back ENOENT where opendir(2) says ENOTDIR.
    row = FileStat(name="a.txt", type=FileType.FILE, extra={"file_id": "f1"})
    with pytest.raises(NotADirectoryError):
        await readdir(
            accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/a.txt"),
            row,
        )


@pytest.mark.asyncio
async def test_readdir_root_includes_shared_drives(accessor, monkeypatch):
    _patched(
        monkeypatch,
        [_file("f1", "readme.txt")],
        [{"id": "drive1", "name": "Team Drive"}],
    )
    rows = _rows(await readdir(accessor, ROOT))
    assert "readme.txt" in rows
    # Shared Drives appear as top-level directories carrying their id.
    assert rows["Team Drive"].type is FileType.DIRECTORY
    assert rows["Team Drive"].extra["drive_id"] == "drive1"


@pytest.mark.asyncio
async def test_readdir_root_uniquifies_duplicate_shared_drive_names(
    accessor, monkeypatch
):
    drives = [
        {"id": "drive1", "name": "Team"},
        {"id": "drive2", "name": "Team"},
        {"id": "drive3", "name": "Team"},
    ]
    _patched(monkeypatch, [], drives)
    rows = _rows(await readdir(accessor, ROOT))
    assert list(rows) == [
        "Team",
        "Team [Shared Drive 2]",
        "Team [Shared Drive]",
    ]
    assert rows["Team"].extra["file_id"] == "drive1"
    assert rows["Team [Shared Drive]"].extra["file_id"] == "drive2"
    assert rows["Team [Shared Drive 2]"].extra["file_id"] == "drive3"


@pytest.mark.asyncio
async def test_a_root_short_of_its_shared_drives_is_partial(
    accessor, monkeypatch
):
    """A short root listing must not be kept as the directory.

    Kept, it would hold the mount My-Drive-only until it expires, long
    after the cause (a missing scope) is fixed. The rows are real, so
    they are answered as a partial listing: kept as rows, not as the
    directory, and the next readdir retries enumeration.
    """
    _patched(
        monkeypatch, [_file("f1", "readme.txt")], RuntimeError("no scope")
    )
    listed = await readdir(accessor, ROOT)
    assert isinstance(listed, DirListing)
    assert listed.partial
    assert _rows(listed)["readme.txt"].extra["file_id"] == "f1"
    _patched(
        monkeypatch,
        [_file("f1", "readme.txt")],
        [{"id": "drive1", "name": "Team"}],
    )
    listed = await readdir(accessor, ROOT)
    assert not isinstance(listed, DirListing)
    assert "Team" in _rows(listed)


@pytest.mark.asyncio
async def test_readdir_workspace_files_get_extensions(accessor, monkeypatch):
    _patched(
        monkeypatch,
        [
            _file("d1", "My Document", "application/vnd.google-apps.document"),
            _file("s1", "My Sheet", "application/vnd.google-apps.spreadsheet"),
            _file(
                "p1", "My Slides", "application/vnd.google-apps.presentation"
            ),
        ],
    )
    rows = _rows(await readdir(accessor, ROOT))
    assert set(rows) == {
        "My Document.gdoc.json",
        "My Sheet.gsheet.json",
        "My Slides.gslide.json",
    }


@pytest.mark.asyncio
async def test_readdir_size_binary_kept_google_apps_in_extra(
    accessor, monkeypatch
):
    _patched(
        monkeypatch,
        [
            _file("f1", "report.pdf", "application/pdf", size="2048"),
            _file(
                "d1",
                "My Document",
                "application/vnd.google-apps.document",
                quotaBytesUsed="9999",
            ),
        ],
    )
    rows = _rows(await readdir(accessor, ROOT))
    # Binary files download raw: Drive's size is the rendered byte length.
    assert rows["report.pdf"].size == 2048
    # Google-apps files render to JSON: Drive's source size must not
    # become the row's size, it lives in extra only.
    doc = rows["My Document.gdoc.json"]
    assert doc.size is None
    assert doc.extra["source_size"] == 9999


@pytest.mark.asyncio
async def test_readdir_scoped_mount_lists_folder_children(
    fake_drive, scoped_accessor
):
    scope = fake_drive.folder("scope")
    fake_drive.add("in.txt", parent=scope, content=b"x")
    fake_drive.add("out.txt", content=b"y")
    rows = _rows(await readdir(scoped_accessor(scope), ROOT))
    assert list(rows) == ["in.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reported_size, expected", [("0", 0), ("42", 42), (None, None)]
)
async def test_binary_size_preserves_zero_and_never_uses_quota(
    accessor, reported_size, expected, monkeypatch
):
    item = _file("binary", "file.txt", quotaBytesUsed="99")
    if reported_size is not None:
        item["size"] = reported_size
    _patched(monkeypatch, [item])
    rows = _rows(await readdir(accessor, PathSpec.from_str_path("/drive", "")))
    assert list(rows) == ["file.txt"]
    result = await stat(
        accessor,
        PathSpec.from_str_path("/drive/file.txt", "file.txt"),
        rows["file.txt"],
    )
    assert result.size == expected


@pytest.mark.asyncio
async def test_readdir_carries_both_content_tokens_onto_the_row(
    accessor, monkeypatch
):
    """A read checks its bytes against the md5 the row carries, so the
    listing has to keep it."""
    _patched(
        monkeypatch,
        [
            _file(
                "f1",
                "report.pdf",
                "application/pdf",
                size="2048",
                md5Checksum="9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e",
                headRevisionId="f1-r3",
            )
        ],
    )
    row = _rows(await readdir(accessor, ROOT))["report.pdf"]
    assert row.extra["md5_checksum"] == "9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e"
    assert row.extra["head_revision_id"] == "f1-r3"
    assert row.fingerprint == "9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e"


@pytest.mark.asyncio
async def test_readdir_omits_the_tokens_a_native_file_does_not_have(
    accessor, monkeypatch
):
    """A gdoc carries neither field, and the key must be absent, not None.

    Key presence is the observable because the listing omits what Drive did
    not send. If the fixture handed every item an md5 instead, the chain's
    second and third steps would never run in any test here.
    """
    _patched(
        monkeypatch,
        [_file("d1", "My Document", "application/vnd.google-apps.document")],
    )
    row = _rows(await readdir(accessor, ROOT))["My Document.gdoc.json"]
    assert "md5_checksum" not in row.extra
    assert "head_revision_id" not in row.extra


@pytest.mark.asyncio
async def test_readdir_keeps_the_drive_beside_the_tokens(
    accessor, monkeypatch
):
    _patched(
        monkeypatch,
        [
            _file(
                "f1",
                "report.pdf",
                "application/pdf",
                size="2048",
                driveId="drive1",
                md5Checksum="9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e",
                headRevisionId="f1-r3",
            ),
            _file(
                "d1",
                "My Document",
                "application/vnd.google-apps.document",
                driveId="drive1",
                quotaBytesUsed="9999",
            ),
        ],
    )
    rows = _rows(await readdir(accessor, ROOT))
    binary = rows["report.pdf"]
    assert binary.extra["drive_id"] == "drive1"
    assert binary.extra["md5_checksum"] == "9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e"
    native = rows["My Document.gdoc.json"]
    assert native.extra["drive_id"] == "drive1"
    assert native.extra["source_size"] == 9999


@pytest.mark.asyncio
async def test_a_shared_drive_root_carries_no_content_token(
    accessor, monkeypatch
):
    """A shared drive root is a directory and has no content to fingerprint.

    The listing builds those rows at a second construction site, which
    the file-row guard cannot reach, so adding the keys there would go
    unnoticed by every other test in this file.
    """
    _patched(monkeypatch, [], [{"id": "drive1", "name": "Team Drive"}])
    row = _rows(await readdir(accessor, ROOT))["Team Drive"]
    assert "md5_checksum" not in row.extra
    assert row.fingerprint is None
