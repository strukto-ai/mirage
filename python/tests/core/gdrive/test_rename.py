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
from mirage.types import PathSpec
from tests.fixtures.handed import call

DOC_MIME = "application/vnd.google-apps.document"


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
