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

FOLDER_MIME = "application/vnd.google-apps.folder"

DOC_MIME = "application/vnd.google-apps.document"


def test_drive_target_name():
    assert drive_target_name("new.gdoc.json", DOC_MIME) == "new"
    assert drive_target_name("new.gdoc.json", "text/plain") == "new.gdoc.json"
    assert drive_target_name("new.txt", DOC_MIME) == "new.txt"


@pytest.mark.asyncio
async def test_a_scoped_mount_lists_its_folder(fake_drive, scoped_accessor):
    scope = fake_drive.folder("scope")
    inner = fake_drive.add("f.txt", parent=scope, content=b"in")
    fake_drive.add("f.txt", content=b"out")
    accessor = scoped_accessor(scope)
    assert await root_context(accessor) == (scope, None)
    rows = await readdir(accessor, PathSpec.from_str_path("/"))
    assert [row.extra["file_id"] for row in rows] == [inner]


@pytest.mark.asyncio
async def test_root_context_shared_drive_scope(fake_drive, scoped_accessor):
    scope = fake_drive.add("team", mime=FOLDER_MIME, drive_id="d1")
    inner = fake_drive.add("f.txt", parent=scope, drive_id="d1")
    accessor = scoped_accessor(scope)
    assert await root_context(accessor) == (scope, "d1")
    rows = await readdir(accessor, PathSpec.from_str_path("/"))
    assert [(row.extra["file_id"], row.extra["drive_id"]) for row in rows] == [
        (inner, "d1")
    ]


@pytest.mark.asyncio
async def test_root_context_memoizes_drive_lookup(
    fake_drive, scoped_accessor, monkeypatch
):
    scope = fake_drive.add("team", mime=FOLDER_MIME, drive_id="d1")
    accessor = scoped_accessor(scope)
    calls = 0
    get_file = fake_drive.get_file

    async def counting_get_file(file_id):
        nonlocal calls
        calls += 1
        return await get_file(file_id)

    monkeypatch.setattr(fake_drive, "get_file", counting_get_file)
    assert await root_context(accessor) == (scope, "d1")
    assert await root_context(accessor) == (scope, "d1")
    assert calls == 1


@pytest.mark.asyncio
async def test_eacces_on_denied_maps_403():
    @eacces_on_denied
    async def denied(accessor, path: PathSpec) -> None:
        raise GoogleApiError("denied", 403)

    @eacces_on_denied
    async def server_error(accessor, path: PathSpec) -> None:
        raise GoogleApiError("boom", 500)

    spec = PathSpec.from_str_path("/gd/a.txt", "a.txt")
    with pytest.raises(PermissionError, match="/gd/a.txt"):
        await denied(None, spec)
    with pytest.raises(GoogleApiError):
        await server_error(None, spec)


@pytest.mark.asyncio
async def test_a_create_at_the_root_lands_in_the_root_folder(
    fake_drive, gdrive_accessor
):
    path = PathSpec.from_str_path("/drive/new.txt", vfs_path="new.txt")
    assert await parent_folder(gdrive_accessor, path, None) == ("root", None)


@pytest.mark.asyncio
async def test_a_create_lands_in_the_folder_its_parent_names(
    fake_drive, gdrive_accessor
):
    folder = FileStat(
        name="a",
        type=FileType.DIRECTORY,
        extra={"file_id": "f1", "drive_id": "d1"},
    )
    path = PathSpec.from_str_path("/drive/a/new.txt", vfs_path="a/new.txt")
    assert await parent_folder(gdrive_accessor, path, folder) == ("f1", "d1")


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["missing", "file"])
async def test_a_parent_that_is_no_folder_names_the_operand(
    fake_drive, gdrive_accessor, kind
):
    parent = (
        None
        if kind == "missing"
        else FileStat(name="a", type=FileType.FILE, extra={"file_id": "f1"})
    )
    path = PathSpec.from_str_path("/drive/a/child", vfs_path="a/child")
    error = FileNotFoundError if kind == "missing" else NotADirectoryError
    with pytest.raises(error) as raised:
        await parent_folder(gdrive_accessor, path, parent)
    assert raised.value.filename == path.virtual
