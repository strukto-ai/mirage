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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.normalize import (normalize_card, normalize_workspace,
                                          to_json_bytes)
from mirage.core.trello.readdir import readdir
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="k", api_token="t"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/workspaces"]


@pytest.mark.asyncio
async def test_readdir_workspaces_seeds_sized_workspace_json(accessor, index):
    ws = {"id": "ws1", "displayName": "Engineering"}
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=[ws]):
        await readdir(
            accessor,
            PathSpec(resource_path="workspaces",
                     virtual="/workspaces",
                     directory="/workspaces"), index)
    lookup = await index.get("/workspaces/Engineering__ws1/workspace.json")
    assert lookup.entry is not None
    assert lookup.entry.size == len(to_json_bytes(normalize_workspace(ws)))
    listing = await index.list_dir("/workspaces/Engineering__ws1")
    assert listing.entries == [
        "/workspaces/Engineering__ws1/workspace.json",
        "/workspaces/Engineering__ws1/boards",
    ]


@pytest.mark.asyncio
async def test_readdir_cards_seeds_sized_card_json(accessor, index):
    await index.put(
        "/workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1",
        IndexEntry(
            id="l1",
            name="Doing",
            resource_type="trello/list",
            vfs_name="Doing__l1",
        ),
    )
    card = {
        "id": "c1",
        "name": "Fix login",
        "idBoard": "b1",
        "idList": "l1",
        "desc": "broken",
        "labels": [],
        "idMembers": [],
        "closed": False,
        "shortUrl": "https://trello.test/c1",
        "dateLastActivity": "2026-04-05T00:00:00.000Z",
    }
    base = "/workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1"
    with patch("mirage.core.trello.readdir.list_list_cards",
               new_callable=AsyncMock,
               return_value=[card]):
        await readdir(
            accessor,
            PathSpec(resource_path=f"{base.strip('/')}/cards",
                     virtual=f"{base}/cards",
                     directory=f"{base}/cards"), index)
    lookup = await index.get(f"{base}/cards/Fix_login__c1/card.json")
    assert lookup.entry is not None
    assert lookup.entry.size == len(to_json_bytes(normalize_card(card)))
    comments = await index.get(f"{base}/cards/Fix_login__c1/comments.jsonl")
    assert comments.entry is not None
    assert comments.entry.size is None


@pytest.mark.asyncio
async def test_readdir_unrecognized_path_raises(accessor, index):
    # Returning [] for an unknown path made `ls` and `tree` report a bogus path
    # as real-but-empty, and left `rg` without a message.
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="__nf_missing__",
                     virtual="/__nf_missing__",
                     directory="/__nf_missing__"), index)


@pytest.mark.asyncio
async def test_readdir_unrecognized_nested_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="workspaces/w/nope/deeper",
                     virtual="/workspaces/w/nope/deeper",
                     directory="/workspaces/w/nope/deeper"), index)
