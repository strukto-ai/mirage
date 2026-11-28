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

import errno

import pytest

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.rename import rename
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.handed import call, entry_at

DOC_MIME = "application/vnd.google-apps.document"
FILE = "/drive/v3/files/:id"
DENIED = "The user does not have sufficient permissions for this file."
REASON = "insufficientFilePermissions"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_rename_in_place(google_account):
    file_id = await google_account.upload("old.txt", b"x")
    before = await google_account.item(file_id)
    await call(
        rename,
        readdir,
        google_account.drive_accessor(),
        spec("/old.txt"),
        dst=spec("/new.txt"),
    )
    item = await google_account.item(file_id)
    assert item["name"] == "new.txt"
    assert item["parents"] == ["root"]
    # A rename is no change to the file's bytes: its time stays.
    assert item["modifiedTime"] == before["modifiedTime"]


@pytest.mark.asyncio
async def test_rename_moves_between_folders(google_account):
    src_dir = await google_account.folder("a")
    dst_dir = await google_account.folder("b")
    file_id = await google_account.upload("f.txt", b"x", src_dir)
    await call(
        rename,
        readdir,
        google_account.drive_accessor(),
        spec("/a/f.txt"),
        dst=spec("/b/g.txt"),
    )
    item = await google_account.item(file_id)
    assert item["name"] == "g.txt"
    assert item["parents"] == [dst_dir]


@pytest.mark.asyncio
async def test_rename_replaces_existing_file(google_account):
    src_id = await google_account.upload("src.txt", b"new")
    await google_account.upload("dst.txt", b"old")
    await call(
        rename,
        readdir,
        google_account.drive_accessor(),
        spec("/src.txt"),
        dst=spec("/dst.txt"),
    )
    assert await google_account.find("src.txt") is None
    assert (await google_account.item(src_id))["name"] == "dst.txt"
    assert len(await google_account.items()) == 1


@pytest.mark.asyncio
async def test_rename_over_nonempty_dir_raises(google_account):
    await google_account.upload("src.txt", b"x")
    folder = await google_account.folder("d")
    await google_account.upload("f.txt", b"y", folder)
    await google_account.upload("g.txt", b"z", folder)
    await google_account.run.record_requests()
    with pytest.raises(OSError) as exc_info:
        await call(
            rename,
            readdir,
            google_account.drive_accessor(),
            spec("/src.txt"),
            dst=spec("/d"),
        )
    assert exc_info.value.errno == errno.ENOTEMPTY
    # The conflict probe is bounded, not a full listing: a listing follows
    # every page token, so asking it with a small page size made one
    # request per child to answer a yes/no. Two children, so a probe that
    # walked every page would make two.
    probes = [
        listing
        for listing in await google_account.listings()
        if listing.folders == [folder]
    ]
    assert [listing.page_size for listing in probes] == [1]


@pytest.mark.asyncio
async def test_rename_replaces_empty_dir(google_account):
    src_id = await google_account.upload("src.txt", b"x")
    await google_account.folder("d")
    await call(
        rename,
        readdir,
        google_account.drive_accessor(),
        spec("/src.txt"),
        dst=spec("/d"),
    )
    assert (await google_account.item(src_id))["name"] == "d"
    assert len(await google_account.items()) == 1


@pytest.mark.asyncio
async def test_rename_missing_src_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await call(
            rename,
            readdir,
            google_account.drive_accessor(),
            spec("/missing.txt"),
            dst=spec("/x.txt"),
        )


@pytest.mark.asyncio
async def test_rename_native_strips_suffix(google_account):
    doc_id = await google_account.create("Report", DOC_MIME)
    await call(
        rename,
        readdir,
        google_account.drive_accessor(),
        spec("/Report.gdoc.json"),
        dst=spec("/Plan.gdoc.json"),
    )
    assert (await google_account.item(doc_id))["name"] == "Plan"


@pytest.mark.asyncio
async def test_rename_refused_keeps_the_destination(google_account):
    src_id = await google_account.upload("src.txt", b"new")
    dst_id = await google_account.upload("dst.txt", b"old")
    await google_account.refuse("PATCH", FILE, 403, DENIED, REASON)
    with pytest.raises(PermissionError):
        await call(
            rename,
            readdir,
            google_account.drive_accessor(),
            spec("/src.txt"),
            dst=spec("/dst.txt"),
        )
    assert (await google_account.item(src_id))["name"] == "src.txt"
    assert await google_account.content(dst_id) == b"old"


@pytest.mark.asyncio
async def test_rename_refused_delete_moves_the_item_back(google_account):
    folder = await google_account.folder("a")
    src_id = await google_account.upload("src.txt", b"new", folder)
    dst_id = await google_account.upload("dst.txt", b"old")
    before = await google_account.item(src_id)
    await google_account.refuse("DELETE", FILE, 403, DENIED, REASON)
    with pytest.raises(PermissionError):
        await call(
            rename,
            readdir,
            google_account.drive_accessor(),
            spec("/a/src.txt"),
            dst=spec("/dst.txt"),
        )
    item = await google_account.item(src_id)
    assert item["name"] == "src.txt"
    assert item["parents"] == [folder]
    assert item["modifiedTime"] == before["modifiedTime"]
    assert await google_account.content(dst_id) == b"old"


@pytest.mark.asyncio
async def test_rename_keeps_a_folder_given_a_child_while_moving(
    google_account,
):
    src_id = await google_account.folder("src")
    dst_id = await google_account.folder("d")
    # Another client writes into the folder after the first emptiness
    # probe, while the move is on its way: the probe made just before the
    # delete sees it, so the folder stays and the move is undone.
    await google_account.run.before_next(
        [("PATCH", FILE)],
        lambda: google_account.upload("late.txt", b"x", dst_id),
    )
    with pytest.raises(OSError) as exc_info:
        await call(
            rename,
            readdir,
            google_account.drive_accessor(),
            spec("/src"),
            dst=spec("/d"),
        )
    assert exc_info.value.errno == errno.ENOTEMPTY
    assert (await google_account.item(src_id))["name"] == "src"
    late = await google_account.find("late.txt")
    assert late is not None and late["parents"] == [dst_id]


@pytest.mark.asyncio
async def test_rename_onto_the_same_item_does_nothing(google_account):
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
    await rename(
        accessor,
        spec("/f.txt"),
        spec("/b/f.txt"),
        entry=entry,
        dst_entry=twin,
    )
    assert await google_account.asked("PATCH", FILE) == []
    assert await google_account.asked("DELETE", FILE) == []
    assert await google_account.content(file_id) == b"data"
