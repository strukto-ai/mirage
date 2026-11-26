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

from mirage.core.box.client import BoxApiError
from mirage.core.box.readdir import readdir
from mirage.types import FileType, PathSpec
from tests.fixtures.handed import entry_at

ROOT = PathSpec(vfs_path="", virtual="/", directory="/")
DOCS = PathSpec(vfs_path="docs", virtual="/docs", directory="/docs")
A_TXT = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/")
ITEMS_ROUTE = "/2.0/folders/:folder_id/items"


@pytest.mark.asyncio
async def test_readdir_root_lists_folder_zero(account):
    await account.mkdir("docs")
    file_id = await account.put("a.txt", b"hello")
    await account.run.record_requests()
    rows = await readdir(account.accessor(), ROOT)
    assert await account.run.requests() == ["GET /2.0/folders/0/items"]
    assert [row.name for row in rows] == ["a.txt", "docs"]
    file, folder = rows
    assert file.extra["box_id"] == file_id
    assert file.size == 5
    assert folder.type is FileType.DIRECTORY
    assert folder.size is None


@pytest.mark.asyncio
async def test_readdir_box_native_files_surface_raw(account):
    await account.put("meeting.boxnote", b'{"doc": {}}')
    rows = await readdir(account.accessor(), ROOT)
    assert [row.name for row in rows] == ["meeting.boxnote"]
    assert rows[0].extra["resource_type"] == "box/file"


@pytest.mark.asyncio
async def test_readdir_keeps_empty_files_and_hides_web_links(account):
    await account.web_link("link")
    await account.put("empty.txt", b"")
    rows = await readdir(account.accessor(), ROOT)
    assert [(row.name, row.size) for row in rows] == [("empty.txt", 0)]


@pytest.mark.asyncio
async def test_readdir_lists_a_subfolder_by_its_row(account):
    docs = await account.mkdir("docs")
    await account.put("notes.txt", b"abc", docs)
    accessor = account.accessor()
    row = await entry_at(readdir, accessor, DOCS)
    await account.run.record_requests()
    rows = await readdir(accessor, DOCS, row)
    assert [row.name for row in rows] == ["notes.txt"]
    assert await account.run.requests() == [f"GET /2.0/folders/{docs}/items"]


@pytest.mark.asyncio
async def test_readdir_missing_folder_raises(account):
    await account.run.record_requests()
    with pytest.raises(FileNotFoundError):
        await readdir(
            account.accessor(),
            PathSpec(vfs_path="ghost", virtual="/ghost", directory="/ghost"),
        )
    assert await account.run.requests() == []


@pytest.mark.asyncio
async def test_readdir_of_a_file_is_enotdir(account):
    await account.put("a.txt", b"hello")
    accessor = account.accessor()
    row = await entry_at(readdir, accessor, A_TXT)
    await account.run.record_requests()
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, A_TXT, row)
    assert await account.run.requests() == []


@pytest.mark.asyncio
async def test_readdir_reads_a_404_listing_as_absence(account):
    # A mount whose root folder Box no longer has.
    with pytest.raises(FileNotFoundError):
        await readdir(account.accessor("9"), ROOT)


@pytest.mark.asyncio
async def test_readdir_keeps_a_throttled_listing_a_failure(account):
    await account.run.answer_next("GET", ITEMS_ROUTE, 429)
    with pytest.raises(BoxApiError) as caught:
        await readdir(account.accessor(), ROOT)
    assert caught.value.status == 429


@pytest.mark.asyncio
@pytest.mark.parametrize("sha1, kept", [(5, None), ("", None), ("abc", "abc")])
async def test_readdir_keeps_only_a_string_sha1(account, sha1, kept):
    # Box's own listing with the sha1 it gave replaced.
    await account.put("a.txt", b"hello")
    listing = await account.run.call("GET", "/2.0/folders/0/items")
    for row in listing["entries"]:
        row["sha1"] = sha1
    await account.run.answer_next("GET", ITEMS_ROUTE, 200, listing)
    rows = await readdir(account.accessor(), ROOT)
    assert rows[0].extra.get("sha1") == kept
    assert rows[0].fingerprint == kept


@pytest.mark.asyncio
async def test_readdir_rows_carry_the_etag_a_write_sends(account):
    file_id = await account.put("a.txt", b"hello")
    await account.upload_version(file_id, b"again")
    rows = await readdir(account.accessor(), ROOT)
    assert rows[0].extra["etag"] == (await account.child("0", "a.txt"))["etag"]
    assert rows[0].extra["etag"] != "0"
