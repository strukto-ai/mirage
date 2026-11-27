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
from mirage.core.gdrive.search import files_containing
from mirage.core.gdrive.tree import PARENTS_PER_QUERY
from mirage.types import PathSpec
from mirage.utils.clock import ManualClock
from tests.fixtures.google_account import FILES, UNTIL_CLEARED
from tests.fixtures.handed import entry_at

TIMEOUT = 0.2


def scope(vfs_path: str = "") -> PathSpec:
    virtual = "/gd/" + vfs_path if vfs_path else "/gd"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _searched(google_account) -> list[list[str]]:
    """The folders each full-text search since recording started asked
    in."""
    return [
        listing.folders
        for listing in await google_account.listings()
        if listing.text is not None
    ]


@pytest.mark.asyncio
async def test_hits_are_the_walked_files_drive_names(google_account):
    sub = await google_account.folder("sub")
    await google_account.upload("a.txt", b"the wombat")
    await google_account.upload("b.txt", b"wombat here", sub)
    await google_account.upload("c.txt", b"nothing")
    await google_account.run.record_requests()
    out = await files_containing(
        google_account.drive_accessor(), "wombat", scope(), None
    )
    assert out is not None
    assert sorted(p.virtual for p in out) == ["/gd/a.txt", "/gd/sub/b.txt"]
    assert await _searched(google_account) == [["root", sub]]


@pytest.mark.asyncio
async def test_a_subfolder_scope_searches_from_its_folder(google_account):
    sub = await google_account.folder("sub")
    await google_account.upload("a.txt", b"wombat")
    await google_account.upload("b.txt", b"wombat", sub)
    accessor = google_account.drive_accessor()
    under = scope("sub")
    entry = await entry_at(readdir, accessor, under)
    await google_account.run.record_requests()
    out = await files_containing(accessor, "wombat", under, entry)
    assert out is not None
    assert [(p.virtual, p.vfs_path) for p in out] == [
        ("/gd/sub/b.txt", "sub/b.txt")
    ]
    assert await _searched(google_account) == [[sub]]


@pytest.mark.asyncio
async def test_many_folders_are_searched_in_batches(google_account):
    for i in range(PARENTS_PER_QUERY + 5):
        await google_account.folder(f"d{i:02d}")
    await google_account.upload("a.txt", b"wombat")
    await google_account.run.record_requests()
    out = await files_containing(
        google_account.drive_accessor(), "wombat", scope(), None
    )
    assert out is not None
    assert [len(s) for s in await _searched(google_account)] == [
        PARENTS_PER_QUERY,
        6,
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    ["no hit", "incomplete", "search fails", "timeout", "listing fails"],
)
async def test_a_search_that_cannot_answer_answers_none(case, google_account):
    await google_account.upload(
        "a.txt", b"nothing" if case == "no hit" else b"wombat"
    )
    if case != "no hit":
        # A run that answers learns the query each request is asked with,
        # so the one refused is that request and no other.
        await google_account.run.record_requests()
        assert await files_containing(
            google_account.drive_accessor(), "wombat", scope(), None
        )
        listings = await google_account.listings()
        search = next(one for one in listings if one.text is not None)
        level = next(one for one in listings if one.level and one.text is None)
        if case == "incomplete":
            # Drive gave up on a corpus: its own answer, marked so.
            asked = await google_account.run.call(
                "GET", f"{FILES}?{search.query}"
            )
            await google_account.run.answer_next(
                "GET",
                FILES,
                200,
                {**asked, "incompleteSearch": True},
                query=search.query,
            )
        else:
            await google_account.run.answer_next(
                "GET",
                FILES,
                None if case == "search fails" else 200,
                times=UNTIL_CLEARED,
                query=(level if case == "listing fails" else search).query,
                delay_ms=0 if case == "search fails" else int(TIMEOUT * 5000),
            )
    accessor = google_account.drive_accessor(ManualClock(), timeout=TIMEOUT)
    out = await files_containing(accessor, "wombat", scope(), None)
    assert out is None
