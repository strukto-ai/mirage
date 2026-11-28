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

from mirage.core.gdrive.copy import copy
from mirage.core.gdrive.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.handed import call, entry_at

FILE = "/drive/v3/files/:id"
COPY = "/drive/v3/files/:id/copy"
REASON = "insufficientFilePermissions"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_copy_file(google_account):
    await google_account.upload("src.txt", b"data")
    await call(
        copy,
        readdir,
        google_account.drive_accessor(),
        spec("/src.txt"),
        dst=spec("/dst.txt"),
    )
    dst = await google_account.find("dst.txt")
    assert dst is not None
    assert await google_account.content(dst["id"]) == b"data"
    assert await google_account.find("src.txt") is not None


@pytest.mark.asyncio
async def test_copy_overwrites_existing_file(google_account):
    await google_account.upload("src.txt", b"new")
    await google_account.upload("dst.txt", b"old")
    await call(
        copy,
        readdir,
        google_account.drive_accessor(),
        spec("/src.txt"),
        dst=spec("/dst.txt"),
    )
    dst = await google_account.find("dst.txt")
    assert dst is not None
    assert await google_account.content(dst["id"]) == b"new"
    assert len(await google_account.items()) == 2


@pytest.mark.asyncio
async def test_copy_file_onto_dir_raises(google_account):
    await google_account.upload("src.txt", b"x")
    await google_account.folder("d")
    with pytest.raises(IsADirectoryError):
        await call(
            copy,
            readdir,
            google_account.drive_accessor(),
            spec("/src.txt"),
            dst=spec("/d"),
        )


@pytest.mark.asyncio
async def test_copy_tree_creates_missing_dir(google_account):
    src = await google_account.folder("src")
    sub = await google_account.folder("sub", src)
    await google_account.upload("f.txt", b"deep", sub)
    await google_account.upload("top.txt", b"top", src)
    await call(
        copy,
        readdir,
        google_account.drive_accessor(),
        spec("/src"),
        dst=spec("/dst"),
    )
    assert await google_account.find("dst") is not None
    items = await google_account.items()
    for name in ("sub", "f.txt", "top.txt"):
        copies = [i for i in items if i["name"] == name]
        assert len(copies) == 2
    deep = [i for i in items if i["name"] == "f.txt"]
    assert {await google_account.content(i["id"]) for i in deep} == {b"deep"}


@pytest.mark.asyncio
async def test_copy_tree_merges_existing_dir(google_account):
    src = await google_account.folder("src")
    await google_account.upload("f.txt", b"x", src)
    dst = await google_account.folder("dst")
    await google_account.upload("keep.txt", b"k", dst)
    await call(
        copy,
        readdir,
        google_account.drive_accessor(),
        spec("/src"),
        dst=spec("/dst"),
    )
    dst_children = [
        i for i in await google_account.items() if dst in i["parents"]
    ]
    assert {i["name"] for i in dst_children} == {"keep.txt", "f.txt"}


@pytest.mark.asyncio
async def test_copy_dir_onto_file_raises(google_account):
    await google_account.folder("src")
    await google_account.upload("f.txt", b"x")
    with pytest.raises(NotADirectoryError):
        await call(
            copy,
            readdir,
            google_account.drive_accessor(),
            spec("/src"),
            dst=spec("/f.txt"),
        )


@pytest.mark.asyncio
async def test_copy_missing_src_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await call(
            copy,
            readdir,
            google_account.drive_accessor(),
            spec("/missing.txt"),
            dst=spec("/dst.txt"),
        )


@pytest.mark.asyncio
async def test_copy_refused_keeps_the_destination(google_account):
    await google_account.upload("src.txt", b"new")
    dst_id = await google_account.upload("dst.txt", b"old")
    await google_account.refuse(
        "POST", COPY, 403, "This file cannot be copied by the user.", REASON
    )
    with pytest.raises(PermissionError):
        await call(
            copy,
            readdir,
            google_account.drive_accessor(),
            spec("/src.txt"),
            dst=spec("/dst.txt"),
        )
    assert await google_account.content(dst_id) == b"old"
    assert len(await google_account.items()) == 2


@pytest.mark.asyncio
async def test_copy_refused_delete_drops_the_copy(google_account):
    await google_account.upload("src.txt", b"new")
    dst_id = await google_account.upload("dst.txt", b"old")
    await google_account.refuse(
        "DELETE",
        FILE,
        403,
        "The user does not have sufficient permissions for this file.",
        REASON,
        path=f"/drive/v3/files/{dst_id}",
    )
    with pytest.raises(PermissionError):
        await call(
            copy,
            readdir,
            google_account.drive_accessor(),
            spec("/src.txt"),
            dst=spec("/dst.txt"),
        )
    assert await google_account.content(dst_id) == b"old"
    assert len(await google_account.items()) == 2


@pytest.mark.asyncio
async def test_copy_onto_the_same_item_does_nothing(google_account):
    file_id = await google_account.upload("f.txt", b"data")
    accessor = google_account.drive_accessor()
    entry = await entry_at(readdir, accessor, spec("/f.txt"))
    # Drive lists a legacy item under each of its parents, so another
    # folder's row can name this same id. A row naming no folder is taken
    # as listed, which stands in for that second listing.
    twin = FileStat(
        name="f.txt", type=FileType.FILE, extra={"file_id": file_id}
    )
    await google_account.run.record_requests()
    await copy(
        accessor, spec("/f.txt"), spec("/b/f.txt"), entry, dst_entry=twin
    )
    assert await google_account.asked("POST", COPY) == []
    assert await google_account.asked("DELETE", FILE) == []
    assert len(await google_account.items()) == 1
