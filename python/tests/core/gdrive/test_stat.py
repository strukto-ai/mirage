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
from mirage.core.gdrive.readdir import stat_from_item
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace

STAMP = "2026-04-01T00:00:00.000Z"
DOC_MIME = "application/vnd.google-apps.document"


@pytest.fixture
def config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def accessor(config):
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=mgr)


def _workspace(accessor) -> Workspace:
    vfs = GoogleDriveVFS(
        config=GoogleDriveConfig(client_id="x", refresh_token="y")
    )
    vfs.accessor = accessor
    return Workspace({"/drive/": vfs}, mode=MountMode.READ)


def _file(file_id: str, name: str, mime: str = "text/plain", **more) -> dict:
    return {"id": file_id, "name": name, "mimeType": mime, **more}


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_answers_the_row_its_parent_listed(accessor):
    row = stat_from_item(
        _file("f1", "report.pdf", "application/pdf", size="1024")
    )
    result = await stat(accessor, PathSpec.from_str_path("/report.pdf"), row)
    assert result == row
    assert result.size == 1024
    assert result.extra["file_id"] == "f1"
    assert result.extra["resource_type"] == "gdrive/file"


@pytest.mark.asyncio
async def test_stat_of_nothing_is_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec.from_str_path("/nonexistent.txt"), None)


@pytest.mark.asyncio
async def test_a_cold_stat_lists_its_parent_once(accessor):
    files = [
        _file(
            "f99",
            "fresh.pdf",
            "application/pdf",
            modifiedTime="2026-04-15T00:00:00.000Z",
            size="2048",
        )
    ]
    ws = _workspace(accessor)
    try:
        with (
            patch(
                "mirage.core.gdrive.readdir.list_files",
                new_callable=AsyncMock,
                return_value=files,
            ) as mock_list,
            patch(
                "mirage.core.gdrive.readdir.list_shared_drives",
                new_callable=AsyncMock,
                return_value=[],
            ),
        ):
            result, _ = await ws.dispatch(
                "stat", PathSpec.from_str_path("/drive/fresh.pdf")
            )
        assert result.name == "fresh.pdf"
        assert result.extra["file_id"] == "f99"
        # binary files download raw, so Drive's size is the rendered length
        assert result.size == 2048
        assert mock_list.call_count == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_failed_parent_listing_propagates(accessor):
    ws = _workspace(accessor)
    try:
        with patch(
            "mirage.core.gdrive.readdir.list_files",
            new_callable=AsyncMock,
            side_effect=RuntimeError("drive unavailable"),
        ):
            with pytest.raises(RuntimeError, match="drive unavailable"):
                await ws.dispatch(
                    "stat", PathSpec.from_str_path("/drive/missing.txt")
                )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["updated", "deleted"])
async def test_a_partial_root_does_not_make_a_child_a_permanent_hit(
    accessor, change, monkeypatch
):
    """A best-effort root listing must not make a child a permanent hit."""
    phase = "initial"

    async def list_files(_tm, folder_id="root", **_kwargs):
        assert folder_id == "root"
        if phase == "initial":
            return [_file("old-file", "readme.txt", size="3")]
        if change == "deleted":
            return []
        return [_file("new-file", "readme.txt", size="42")]

    async def list_shared_drives(_tm):
        if phase == "initial":
            raise RuntimeError("missing scope")
        return []

    monkeypatch.setattr("mirage.core.gdrive.readdir.list_files", list_files)
    monkeypatch.setattr(
        "mirage.core.gdrive.readdir.list_shared_drives", list_shared_drives
    )
    ws = _workspace(accessor)
    try:
        await ws.dispatch("readdir", PathSpec.from_str_path("/drive"))
        index = ws.mount("/drive/").index_store
        assert (await index.list_dir("/drive")).entries is None
        await index.invalidate()
        phase = "refresh"
        path = PathSpec.from_str_path("/drive/readme.txt")
        if change == "updated":
            result, _ = await ws.dispatch("stat", path)
            assert result.extra["file_id"] == "new-file"
            assert result.size == 42
        else:
            with pytest.raises(FileNotFoundError):
                await ws.dispatch("stat", path)
    finally:
        await ws.close()


@pytest.mark.parametrize(
    "tokens,expected",
    [
        ({"md5Checksum": "abc", "headRevisionId": "r3"}, "abc"),
        ({"headRevisionId": "r3"}, "r3"),
        ({}, None),
    ],
    ids=["md5", "head-revision", "neither"],
)
def test_a_file_with_content_is_stamped_by_its_tokens(tokens, expected):
    row = stat_from_item(
        _file("file123", "report.pdf", modifiedTime=STAMP, **tokens)
    )
    assert row.fingerprint == expected


def test_a_doc_is_stamped_by_its_modified_time():
    row = stat_from_item(_file("doc123", "doc", DOC_MIME, modifiedTime=STAMP))
    assert row.fingerprint == STAMP


def test_an_item_renders_every_kind_in_full(fake_drive):
    # Each kind's name suffix, size, token and extras.
    doc = fake_drive.add("Report", mime=DOC_MIME)
    folder = fake_drive.folder("d")
    blob = fake_drive.add("a.bin", content=b"hello")
    assert stat_from_item(fake_drive.public(doc)) == FileStat(
        name="Report.gdoc.json",
        size=None,
        modified="2026-01-01T00:00:00Z",
        fingerprint="2026-01-01T00:00:00Z",
        type=FileType.FILE,
        content=ContentType.JSON,
        extra={
            "file_id": "id1",
            "mime_type": DOC_MIME,
            "resource_type": "gdrive/gdoc",
        },
    )
    assert stat_from_item(fake_drive.public(folder)) == FileStat(
        name="d",
        modified="2026-01-01T00:00:00Z",
        type=FileType.DIRECTORY,
        extra={
            "file_id": "id2",
            "mime_type": "application/vnd.google-apps.folder",
        },
    )
    assert stat_from_item(fake_drive.public(blob)) == FileStat(
        name="a.bin",
        size=5,
        modified="2026-01-01T00:00:00Z",
        fingerprint="5d41402abc4b2a76b9719d911017c592",
        type=FileType.FILE,
        content=ContentType.BINARY,
        extra={
            "file_id": "id3",
            "mime_type": "application/octet-stream",
            "md5_checksum": "5d41402abc4b2a76b9719d911017c592",
            "head_revision_id": "id3-r1",
            "resource_type": "gdrive/file",
        },
    )
