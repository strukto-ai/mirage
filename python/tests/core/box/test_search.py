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

from mirage.core.box.api import SEARCH_FIELDS
from mirage.core.box.readdir import readdir
from mirage.core.box.search import files_containing
from mirage.types import PathSpec
from tests.fixtures.handed import entry_at

SEARCH_ROUTE = "/2.0/search"
NEEDLE = b"a needle in it"


def mount_root() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/data", directory="/data")


async def _scope_of(account) -> str:
    """The folder the one search since recording was scoped to."""
    (sent,) = await account.run.params("GET", SEARCH_ROUTE)
    return sent["ancestor_folder_ids"]


@pytest.mark.asyncio
async def test_hits_are_named_from_their_path_collection(account):
    # A mount rooted at /data, given Box's answer for the whole account:
    # the hit in another folder is no path under the mount.
    data = await account.mkdir("data")
    await account.put("x.txt", NEEDLE, data)
    sub = await account.mkdir("Sub", data)
    await account.put("y.txt", NEEDLE, sub)
    await account.put("out.txt", NEEDLE, await account.mkdir("Elsewhere"))
    everywhere = await account.run.call(
        "GET", f"/2.0/search?query=needle&type=file&fields={SEARCH_FIELDS}"
    )
    assert len(everywhere["entries"]) == 3
    await account.run.answer_next("GET", SEARCH_ROUTE, 200, everywhere)
    await account.run.record_requests()
    out = await files_containing(
        account.accessor(data), "needle", mount_root()
    )
    assert await _scope_of(account) == data
    assert out is not None
    assert sorted((p.virtual, p.vfs_path) for p in out) == [
        ("/data/Sub/y.txt", "Sub/y.txt"),
        ("/data/x.txt", "x.txt"),
    ]


@pytest.mark.asyncio
async def test_a_subfolder_scope_searches_under_its_folder_id(account):
    docs = await account.mkdir("docs")
    await account.put("in.txt", NEEDLE, docs)
    await account.put("top.txt", NEEDLE)
    scope = PathSpec(
        vfs_path="docs", virtual="/data/docs", directory="/data/docs"
    )
    accessor = account.accessor()
    row = await entry_at(readdir, accessor, scope)
    await account.run.record_requests()
    out = await files_containing(accessor, "needle", scope, row)
    assert await _scope_of(account) == docs
    assert out is not None
    assert [(p.virtual, p.vfs_path) for p in out] == [
        ("/data/docs/in.txt", "docs/in.txt")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["api-error", "truncated", "no-hit"])
async def test_an_answer_that_may_miss_a_match_is_none(account, answer):
    # No hit is distrusted too: Box indexes a write after it lands.
    await account.put("x.txt", NEEDLE)
    if answer == "api-error":
        await account.run.answer_next("GET", SEARCH_ROUTE, 500)
    elif answer == "truncated":
        page = await account.run.call(
            "GET", f"/2.0/search?query=needle&fields={SEARCH_FIELDS}"
        )
        await account.run.answer_next(
            "GET",
            SEARCH_ROUTE,
            200,
            {**page, "total_count": 20_000, "entries": page["entries"] * 200},
            times=60,
        )
    query = "absent" if answer == "no-hit" else "needle"
    out = await files_containing(account.accessor(), query, mount_root())
    assert out is None


@pytest.mark.asyncio
async def test_a_scope_that_is_no_folder_is_none(account):
    await account.put("a.txt", NEEDLE)
    scope = PathSpec(
        vfs_path="a.txt", virtual="/data/a.txt", directory="/data/a.txt"
    )
    accessor = account.accessor()
    row = await entry_at(readdir, accessor, scope)
    await account.run.record_requests()
    out = await files_containing(accessor, "needle", scope, row)
    assert out is None
    assert await account.run.requests() == []
