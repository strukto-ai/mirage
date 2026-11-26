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

from mirage.core.box.resolve import (
    mount_relative_key,
    resolve_chain,
    resolve_item,
)


async def _tree(account) -> dict[str, str]:
    """``team/docs`` and ``a.txt`` at the root, by name to id."""
    team = await account.mkdir("team")
    return {
        "team": team,
        "docs": await account.mkdir("docs", team),
        "a.txt": await account.put("a.txt", b"a"),
    }


@pytest.mark.asyncio
async def test_resolve_chain_stops_at_the_first_missing_component(account):
    ids = await _tree(account)
    chain = await resolve_chain(account.accessor(), ["team", "gone", "x"])
    assert [c["id"] for c in chain] == [ids["team"]]


@pytest.mark.asyncio
async def test_resolve_chain_never_lists_a_file(account):
    ids = await _tree(account)
    await account.run.record_requests()
    chain = await resolve_chain(account.accessor(), ["a.txt", "x"])
    assert [c["id"] for c in chain] == [ids["a.txt"]]
    assert await account.run.requests() == ["GET /2.0/folders/0/items"]


@pytest.mark.asyncio
async def test_resolve_item_answers_only_for_the_whole_path(account):
    ids = await _tree(account)
    accessor = account.accessor()
    docs = await resolve_item(accessor, ["team", "docs"])
    assert docs["id"] == ids["docs"]
    assert (await resolve_item(accessor, ["a.txt"]))["id"] == ids["a.txt"]
    assert await resolve_item(accessor, ["team", "gone"]) is None
    assert await resolve_item(accessor, ["a.txt", "x"]) is None
    assert await resolve_item(accessor, []) is None


def test_mount_relative_key_trims_through_the_mount_root():
    item = {
        "name": "a.txt",
        "path_collection": {
            "entries": [
                {"id": "0", "name": "All Files"},
                {"id": "10", "name": "team"},
                {"id": "11", "name": "docs"},
            ]
        },
    }
    assert mount_relative_key(item, "0") == "team/docs/a.txt"
    assert mount_relative_key(item, "10") == "docs/a.txt"
    assert mount_relative_key(item, "99") is None
