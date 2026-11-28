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

from http import HTTPStatus

import pytest

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.tree import (
    PARENTS_PER_QUERY,
    iter_tree,
    list_level,
    tree,
    vfs_name,
)
from mirage.types import FileType, PathSpec
from mirage.utils.clock import ManualClock
from tests.fixtures.google_account import DRIVES, FILES, UNTIL_CLEARED
from tests.fixtures.handed import entry_at

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def scope(vfs_path: str = "") -> PathSpec:
    virtual = "/gd/" + vfs_path if vfs_path else "/gd"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _levels(google_account) -> list[tuple[list[str], str | None]]:
    """The folders and shared drive of each level a walk listed at once,
    since recording started."""
    return [
        (listing.folders, listing.drive)
        for listing in await google_account.listings()
        if listing.level
    ]


async def seed_tree(google_account) -> str:
    sub = await google_account.folder("sub")
    await google_account.upload("a.txt", b"aaaa")
    await google_account.upload("big.bin", b"x" * 2048, sub)
    await google_account.upload("small.bin", b"x" * 16, sub)
    await google_account.create("Report", DOC_MIME)
    return sub


@pytest.mark.asyncio
async def test_iter_tree_walks_sorted(google_account):
    sub = await seed_tree(google_account)
    await google_account.run.record_requests()
    walked = []
    async for rel, item, is_dir in iter_tree(
        google_account.drive_accessor(), spec("/"), "root", None
    ):
        walked.append((rel, is_dir))
    assert walked == [
        ("Report.gdoc.json", False),
        ("a.txt", False),
        ("sub", True),
        ("sub/big.bin", False),
        ("sub/small.bin", False),
    ]
    assert await _levels(google_account) == [(["root"], None), ([sub], None)]


@pytest.mark.asyncio
async def test_tree_lists_a_level_per_query(google_account):
    sub = await google_account.folder("sub")
    other = await google_account.folder("other")
    deep = await google_account.folder("deep", sub)
    await google_account.upload("a.txt", b"a")
    await google_account.upload("b.txt", b"bb", sub)
    made = await google_account.upload("c.txt", b"ccc", deep)
    await google_account.run.record_requests()
    found = await tree(google_account.drive_accessor(), scope())
    assert found is not None
    assert sorted(found) == [
        "a.txt",
        "other",
        "sub",
        "sub/b.txt",
        "sub/deep",
        "sub/deep/c.txt",
    ]
    assert found["sub/deep"].type is FileType.DIRECTORY
    assert found["sub/deep/c.txt"].size == 3
    assert found["sub/deep/c.txt"].extra["file_id"] == made
    assert await _levels(google_account) == [
        ([other, sub], None),
        ([deep], None),
    ]
    listings = await google_account.listings()
    assert len([listing for listing in listings if not listing.level]) == 1


@pytest.mark.asyncio
async def test_a_wide_level_is_split_into_queries(google_account):
    for i in range(PARENTS_PER_QUERY + 5):
        await google_account.folder(f"d{i:02d}")
    await google_account.run.record_requests()
    found = await tree(google_account.drive_accessor(), scope())
    assert found is not None
    assert len(found) == PARENTS_PER_QUERY + 5
    assert [len(ids) for ids, _ in await _levels(google_account)] == [
        PARENTS_PER_QUERY,
        5,
    ]


@pytest.mark.asyncio
async def test_a_subfolder_tree_starts_at_its_listing(google_account):
    sub = await google_account.folder("sub")
    deep = await google_account.folder("deep", sub)
    await google_account.upload("a.txt", b"a")
    await google_account.upload("c.txt", b"c", deep)
    accessor = google_account.drive_accessor()
    under = scope("sub")
    found = await tree(
        accessor, under, await entry_at(readdir, accessor, under)
    )
    assert found is not None
    assert sorted(found) == ["deep", "deep/c.txt"]


@pytest.mark.asyncio
async def test_a_missing_folder_raises_what_its_listing_raises(
    google_account,
):
    with pytest.raises(FileNotFoundError):
        await tree(google_account.drive_accessor(), scope("gone"), None)


@pytest.mark.asyncio
async def test_a_short_root_listing_is_left_to_the_walk(google_account):
    await google_account.folder("sub")
    await google_account.refuse(
        "GET", DRIVES, HTTPStatus.FORBIDDEN, "Insufficient scope"
    )
    await google_account.run.record_requests()
    assert await tree(google_account.drive_accessor(), scope()) is None
    assert await _levels(google_account) == []


@pytest.mark.asyncio
async def test_of_two_names_alike_the_last_row_stands(google_account):
    first = await google_account.folder("twin")
    second = await google_account.folder("twin")
    # Drive lists newest first: the second folder, older, is the last row.
    await google_account.patch(first, modifiedTime="2021-01-01T00:00:00Z")
    await google_account.patch(second, modifiedTime="2020-01-01T00:00:00Z")
    await google_account.upload("one.txt", b"1", first)
    await google_account.upload("two.txt", b"2", second)
    found = await tree(google_account.drive_accessor(), scope())
    assert found is not None
    assert sorted(found) == ["twin", "twin/two.txt"]
    assert found["twin"].extra["file_id"] == second


@pytest.mark.asyncio
async def test_a_level_is_asked_per_shared_drive(google_account):
    mine = await google_account.folder("mine")
    drive = await google_account.shared_drive("Team")
    left = await google_account.folder("left", drive)
    right = await google_account.folder("right", drive)
    lone = await google_account.upload("x.txt", b"x", left)
    await google_account.upload("y.txt", b"y", right)
    await google_account.run.record_requests()
    children = await list_level(
        google_account.drive_accessor(),
        [(mine, None), (left, drive), (right, drive)],
    )
    assert await _levels(google_account) == [
        ([mine], None),
        ([left, right], drive),
    ]
    assert children[mine] == []
    assert [item["id"] for item in children[left]] == [lone]
    assert [item["name"] for item in children[right]] == ["y.txt"]


def test_vfs_name_renders_native_suffix():
    assert (
        vfs_name({"name": "Report", "mimeType": DOC_MIME})
        == "Report.gdoc.json"
    )
    assert vfs_name({"name": "a.txt", "mimeType": "text/plain"}) == "a.txt"


@pytest.mark.asyncio
async def test_a_level_that_fails_is_left_to_the_walk(google_account):
    await google_account.folder("sub")
    # A walk that answers learns the query the level is asked with, so
    # the connection dropped is that level's and no other listing's.
    await google_account.run.record_requests()
    assert await tree(google_account.drive_accessor(), scope()) is not None
    level = next(one for one in await google_account.listings() if one.level)
    await google_account.run.answer_next(
        "GET", FILES, None, times=UNTIL_CLEARED, query=level.query
    )
    accessor = google_account.drive_accessor(ManualClock())
    assert await tree(accessor, scope()) is None


@pytest.mark.asyncio
async def test_a_level_is_paged_no_further_than_a_walks_limit(
    google_account,
):
    sub = await google_account.folder("sub")
    for i in range(5):
        await google_account.upload(f"f{i}.txt", b"x", sub)
    await google_account.run.record_requests()
    assert (
        await tree(google_account.drive_accessor(), scope(), limit=3) is None
    )
    sizes = [
        listing.page_size
        for listing in await google_account.listings()
        if listing.level
    ]
    assert sizes == [3]


@pytest.mark.asyncio
async def test_a_level_asks_no_query_past_a_walks_limit(google_account):
    for i in range(PARENTS_PER_QUERY + 1):
        folder = await google_account.folder(f"d{i:02d}")
        await google_account.upload("f.txt", b"x", folder)
    limit = PARENTS_PER_QUERY + 10
    await google_account.run.record_requests()
    assert (
        await tree(google_account.drive_accessor(), scope(), limit=limit)
        is None
    )
    sizes = [
        listing.page_size
        for listing in await google_account.listings()
        if listing.level
    ]
    assert sizes == [10]
