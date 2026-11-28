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

import hashlib
from http import HTTPStatus

import pytest

from mirage.core.gdrive.readdir import stat_from_item
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import GoogleApiError
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.utils.clock import ManualClock
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import DRIVES, FILES, UNTIL_CLEARED

STAMP = "2026-04-01T00:00:00.000Z"
DOC_MIME = "application/vnd.google-apps.document"


def _workspace(google_account, **fields) -> Workspace:
    vfs = GoogleDriveVFS(
        config=google_account.config(GoogleDriveConfig, **fields)
    )
    return Workspace({"/drive/": vfs}, mode=MountMode.READ)


def _file(file_id: str, name: str, mime: str = "text/plain", **more) -> dict:
    return {"id": file_id, "name": name, "mimeType": mime, **more}


@pytest.mark.asyncio
async def test_stat_root(google_account):
    result = await stat(
        google_account.drive_accessor(),
        PathSpec(vfs_path="", virtual="/", directory="/"),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_answers_the_row_its_parent_listed(google_account):
    row = stat_from_item(
        _file("f1", "report.pdf", "application/pdf", size="1024")
    )
    await google_account.run.record_requests()
    result = await stat(
        google_account.drive_accessor(),
        PathSpec.from_str_path("/report.pdf"),
        row,
    )
    assert result == row
    assert result.size == 1024
    assert result.extra["file_id"] == "f1"
    assert result.extra["resource_type"] == "gdrive/file"
    assert await google_account.log() == []


@pytest.mark.asyncio
async def test_stat_of_nothing_is_not_found(google_account):
    with pytest.raises(FileNotFoundError):
        await stat(
            google_account.drive_accessor(),
            PathSpec.from_str_path("/nonexistent.txt"),
            None,
        )


@pytest.mark.asyncio
async def test_a_cold_stat_lists_its_parent_once(google_account):
    made = await google_account.upload("fresh.pdf", b"p" * 2048)
    await google_account.run.record_requests()
    ws = _workspace(google_account)
    try:
        result, _ = await ws.dispatch(
            "stat", PathSpec.from_str_path("/drive/fresh.pdf")
        )
        assert result.name == "fresh.pdf"
        assert result.extra["file_id"] == made
        # binary files download raw, so Drive's size is the rendered length
        assert result.size == 2048
        listed = [
            d for name, d in await google_account.log() if name == "list"
        ]
        assert listed == ["root"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_failed_parent_listing_propagates(google_account):
    await google_account.refuse(
        "GET",
        FILES,
        HTTPStatus.SERVICE_UNAVAILABLE,
        "Backend Error",
        reason="backendError",
        times=UNTIL_CLEARED,
    )
    # A workspace binds its own clock to its mounts' clients, so the
    # retries wait on the clock it is handed.
    vfs = GoogleDriveVFS(config=google_account.config(GoogleDriveConfig))
    ws = Workspace({"/drive/": vfs}, mode=MountMode.READ, clock=ManualClock())
    try:
        with pytest.raises(GoogleApiError, match="Backend Error"):
            await ws.dispatch(
                "stat", PathSpec.from_str_path("/drive/missing.txt")
            )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["updated", "deleted"])
async def test_a_partial_root_does_not_make_a_child_a_permanent_hit(
    google_account, change
):
    """A best-effort root listing must not make a child a permanent hit."""
    old = await google_account.upload("readme.txt", b"old")
    await google_account.refuse(
        "GET", DRIVES, HTTPStatus.FORBIDDEN, "Insufficient scope"
    )
    ws = _workspace(google_account)
    try:
        await ws.dispatch("readdir", PathSpec.from_str_path("/drive"))
        index = ws.mount("/drive/").index_store
        assert (await index.list_dir("/drive")).entries is None
        await index.invalidate()
        await google_account.delete(old)
        path = PathSpec.from_str_path("/drive/readme.txt")
        if change == "updated":
            made = await google_account.upload("readme.txt", b"x" * 42)
            result, _ = await ws.dispatch("stat", path)
            assert result.extra["file_id"] == made
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


@pytest.mark.asyncio
async def test_an_item_renders_every_kind_in_full(google_account):
    # Each kind's name suffix, size, token and extras, from the items as
    # Drive answers them.
    doc = await google_account.item(
        await google_account.create("Report", DOC_MIME)
    )
    folder = await google_account.item(await google_account.folder("d"))
    blob = await google_account.item(
        await google_account.upload("a.bin", b"hello")
    )
    assert stat_from_item(doc) == FileStat(
        name="Report.gdoc.json",
        size=None,
        modified=doc["modifiedTime"],
        fingerprint=doc["modifiedTime"],
        type=FileType.FILE,
        content=ContentType.JSON,
        extra={
            "file_id": doc["id"],
            "mime_type": DOC_MIME,
            "parents": ["root"],
            "resource_type": "gdrive/gdoc",
        },
    )
    assert stat_from_item(folder) == FileStat(
        name="d",
        modified=folder["modifiedTime"],
        type=FileType.DIRECTORY,
        extra={
            "file_id": folder["id"],
            "mime_type": "application/vnd.google-apps.folder",
            "parents": ["root"],
        },
    )
    md5 = hashlib.md5(b"hello").hexdigest()
    assert stat_from_item(blob) == FileStat(
        name="a.bin",
        size=5,
        modified=blob["modifiedTime"],
        fingerprint=md5,
        type=FileType.FILE,
        content=ContentType.BINARY,
        extra={
            "file_id": blob["id"],
            "mime_type": "application/octet-stream",
            "parents": ["root"],
            "md5_checksum": md5,
            "head_revision_id": blob["headRevisionId"],
            "resource_type": "gdrive/file",
        },
    )
