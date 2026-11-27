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

import pytest

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.resolve import (
    drive_target_name,
    eacces_on_denied,
    parent_folder,
    root_context,
)
from mirage.core.google.client import GoogleApiError
from mirage.types import FileStat, FileType, PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def test_drive_target_name():
    assert drive_target_name("new.gdoc.json", DOC_MIME) == "new"
    assert drive_target_name("new.gdoc.json", "text/plain") == "new.gdoc.json"
    assert drive_target_name("new.txt", DOC_MIME) == "new.txt"


@pytest.mark.asyncio
async def test_a_scoped_mount_lists_its_folder(google_account):
    scope = await google_account.folder("scope")
    inner = await google_account.upload("f.txt", b"in", scope)
    await google_account.upload("f.txt", b"out")
    accessor = google_account.drive_accessor(folder_id=scope)
    assert await root_context(accessor) == (scope, None)
    rows = await readdir(accessor, PathSpec.from_str_path("/"))
    assert [row.extra["file_id"] for row in rows] == [inner]


@pytest.mark.asyncio
async def test_root_context_shared_drive_scope(google_account):
    drive = await google_account.shared_drive("Team")
    scope = await google_account.folder("team", drive)
    inner = await google_account.upload("f.txt", b"in", scope)
    accessor = google_account.drive_accessor(folder_id=scope)
    assert await root_context(accessor) == (scope, drive)
    rows = await readdir(accessor, PathSpec.from_str_path("/"))
    assert [(row.extra["file_id"], row.extra["drive_id"]) for row in rows] == [
        (inner, drive)
    ]


@pytest.mark.asyncio
async def test_root_context_memoizes_drive_lookup(google_account):
    drive = await google_account.shared_drive("Team")
    scope = await google_account.folder("team", drive)
    accessor = google_account.drive_accessor(folder_id=scope)
    await google_account.run.record_requests()
    assert await root_context(accessor) == (scope, drive)
    assert await root_context(accessor) == (scope, drive)
    assert await google_account.log() == [("get", scope)]


@eacces_on_denied
async def _denied(accessor, path: PathSpec) -> None:
    raise GoogleApiError("denied", 403)


@eacces_on_denied
async def _server_error(accessor, path: PathSpec) -> None:
    raise GoogleApiError("boom", 500)


@pytest.mark.asyncio
async def test_eacces_on_denied_maps_403():
    spec = PathSpec.from_str_path("/gd/a.txt", "a.txt")
    with pytest.raises(PermissionError, match="/gd/a.txt"):
        await _denied(None, spec)
    with pytest.raises(GoogleApiError):
        await _server_error(None, spec)


@pytest.mark.asyncio
async def test_a_create_at_the_root_lands_in_the_root_folder(google_account):
    path = PathSpec.from_str_path("/drive/new.txt", vfs_path="new.txt")
    assert await parent_folder(
        google_account.drive_accessor(), path, None
    ) == ("root", None)


@pytest.mark.asyncio
async def test_a_create_lands_in_the_folder_its_parent_names(google_account):
    drive = await google_account.shared_drive("Team")
    made = await google_account.folder("a", drive)
    folder = FileStat(
        name="a",
        type=FileType.DIRECTORY,
        extra={"file_id": made, "drive_id": drive},
    )
    path = PathSpec.from_str_path("/drive/a/new.txt", vfs_path="a/new.txt")
    assert await parent_folder(
        google_account.drive_accessor(), path, folder
    ) == (made, drive)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["missing", "file"])
async def test_a_parent_that_is_no_folder_names_the_operand(
    google_account, kind
):
    parent = (
        None
        if kind == "missing"
        else FileStat(
            name="a",
            type=FileType.FILE,
            extra={"file_id": await google_account.upload("a", b"a")},
        )
    )
    path = PathSpec.from_str_path("/drive/a/child", vfs_path="a/child")
    error = FileNotFoundError if kind == "missing" else NotADirectoryError
    with pytest.raises(error) as raised:
        await parent_folder(google_account.drive_accessor(), path, parent)
    assert raised.value.filename == path.virtual
