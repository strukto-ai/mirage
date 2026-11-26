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

from mirage.core.dropbox.search import files_containing
from mirage.types import PathSpec

SEARCH_ROUTE = "/2/files/search_v2"
NEEDLE = b"a needle in it"


def mount_root() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/data", directory="/data")


def subdir() -> PathSpec:
    return PathSpec(
        vfs_path="docs", virtual="/data/docs", directory="/data/docs"
    )


async def _search(account, scope, root_path="/"):
    """The virtual paths a search names, and the path it was scoped to."""
    await account.run.record_requests()
    out = await files_containing(
        account.accessor(root_path), "needle", [scope]
    )
    (sent,) = await account.run.bodies("POST", SEARCH_ROUTE)
    named = None if out is None else sorted(p.virtual for p in out)
    return named, sent["options"].get("path", "")


@pytest.mark.asyncio
async def test_hits_are_named_from_their_display_path(account):
    await account.put("/x.txt", NEEDLE)
    await account.put("/Sub/Y.txt", NEEDLE)
    assert await _search(account, mount_root()) == (
        ["/data/Sub/Y.txt", "/data/x.txt"],
        "",
    )


@pytest.mark.asyncio
async def test_the_root_path_is_stripped_case_insensitively(account):
    # Dropbox answers each hit's path_lower beside its display case; the
    # root comes off the lowered one.
    await account.put("/Team/Sub/A.txt", NEEDLE)
    out = await _search(account, mount_root(), "/Team")
    assert out == (["/data/Sub/A.txt"], "/Team")


@pytest.mark.asyncio
async def test_hits_outside_the_scope_are_dropped(account):
    # A search scoped to /docs, given Dropbox's answer for the whole
    # account: the hit under /other is no path in the scope.
    await account.put("/docs/in.txt", NEEDLE)
    await account.put("/other/out.txt", NEEDLE)
    everywhere = await account.run.call(
        "POST", SEARCH_ROUTE, json={"query": "needle"}
    )
    assert len(everywhere["matches"]) == 2
    await account.run.answer_next("POST", SEARCH_ROUTE, 200, everywhere)
    assert await _search(account, subdir()) == (["/data/docs/in.txt"], "/docs")


def _match(i: int) -> dict:
    path = f"/f{i}.txt"
    return {
        "match_type": {".tag": "content"},
        "metadata": {
            ".tag": "metadata",
            "metadata": {
                ".tag": "file",
                "name": path[1:],
                "path_lower": path,
                "path_display": path,
            },
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["truncated", "no-hit", "api-error"])
async def test_an_answer_that_may_miss_a_match_is_none(account, answer):
    # No hit is distrusted too: Dropbox indexes a write after it lands.
    if answer == "truncated":
        page = {
            "matches": [_match(i) for i in range(10_000)],
            "has_more": False,
        }
        await account.run.answer_next("POST", SEARCH_ROUTE, 200, page)
    elif answer == "api-error":
        await account.run.answer_next("POST", SEARCH_ROUTE, 500)
    out = await files_containing(account.accessor(), "needle", [mount_root()])
    assert out is None
