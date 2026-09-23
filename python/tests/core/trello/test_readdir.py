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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.normalize import (normalize_card, normalize_workspace,
                                          to_json_bytes)
from mirage.core.trello.readdir import readdir
from mirage.types import PathSpec
from mirage.vfs.trello.config import TrelloConfig


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="k", api_token="t"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(accessor,
                           PathSpec(vfs_path="", virtual="/", directory="/"),
                           index)
    assert result == ["/workspaces"]


@pytest.mark.asyncio
async def test_readdir_workspace_dir_carries_sized_workspace_json(
        accessor, index):
    ws = {"id": "ws1", "displayName": "Engineering"}
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=[ws]):
        result = await readdir(
            accessor,
            PathSpec(vfs_path="workspaces/Engineering__ws1",
                     virtual="/workspaces/Engineering__ws1",
                     directory="/workspaces/Engineering__ws1"), index)
    assert result == [
        "/workspaces/Engineering__ws1/workspace.json",
        "/workspaces/Engineering__ws1/boards",
    ]
    lookup = await index.get("/workspaces/Engineering__ws1/workspace.json")
    assert lookup.entry is not None
    assert lookup.entry.size == len(to_json_bytes(normalize_workspace(ws)))


@pytest.mark.asyncio
async def test_readdir_card_dir_carries_sized_card_json(accessor, index):
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
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "ws1",
                   "displayName": "Engineering"
               }]), \
         patch("mirage.core.trello.readdir.list_workspace_boards",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "b1",
                   "name": "Roadmap"
               }]), \
         patch("mirage.core.trello.readdir.list_board_lists",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "l1",
                   "name": "Doing"
               }]), \
         patch("mirage.core.trello.readdir.list_list_cards",
               new_callable=AsyncMock,
               return_value=[card]):
        result = await readdir(
            accessor,
            PathSpec(vfs_path=f"{base.strip('/')}/cards/Fix_login__c1",
                     virtual=f"{base}/cards/Fix_login__c1",
                     directory=f"{base}/cards/Fix_login__c1"), index)
    assert result == [
        f"{base}/cards/Fix_login__c1/card.json",
        f"{base}/cards/Fix_login__c1/comments.jsonl",
    ]
    lookup = await index.get(f"{base}/cards/Fix_login__c1/card.json")
    assert lookup.entry is not None
    assert lookup.entry.size == len(to_json_bytes(normalize_card(card)))
    comments = await index.get(f"{base}/cards/Fix_login__c1/comments.jsonl")
    assert comments.entry is not None
    assert comments.entry.size is None


@pytest.mark.asyncio
async def test_readdir_traversal_never_refetches_a_listing(accessor, index):
    # Entering a directory a traversal just listed resolves through the
    # cached parent listing; the old find chain re-fetched every ancestor
    # listing per directory, which made a recursive walk quadratic in
    # listing payloads.
    cards = [{"id": f"c{i}", "name": f"Card {i}"} for i in range(3)]
    base = "/workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1"
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "ws1",
                   "displayName": "Engineering"
               }]) as ws_mock, \
         patch("mirage.core.trello.readdir.list_workspace_boards",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "b1",
                   "name": "Roadmap"
               }]) as boards_mock, \
         patch("mirage.core.trello.readdir.list_board_lists",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "l1",
                   "name": "Doing"
               }]) as lists_mock, \
         patch("mirage.core.trello.readdir.list_list_cards",
               new_callable=AsyncMock,
               return_value=cards) as cards_mock:
        listed = await readdir(
            accessor,
            PathSpec(vfs_path=f"{base.strip('/')}/cards",
                     virtual=f"{base}/cards",
                     directory=f"{base}/cards"), index)
        for card_dir in listed:
            await readdir(
                accessor,
                PathSpec(vfs_path=card_dir.strip("/"),
                         virtual=card_dir,
                         directory=card_dir), index)
    assert ws_mock.await_count == 1
    assert boards_mock.await_count == 1
    assert lists_mock.await_count == 1
    assert cards_mock.await_count == 1


@pytest.mark.asyncio
async def test_readdir_unknown_workspace_raises(accessor, index):
    # No listed workspace carries the typed `label__id` dirname, so the
    # kit's entry resolution comes back empty and reports ENOENT.
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "ws1",
                   "displayName": "Engineering"
               }]):
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(vfs_path="workspaces/Ghost__nope/boards",
                         virtual="/workspaces/Ghost__nope/boards",
                         directory="/workspaces/Ghost__nope/boards"), index)


@pytest.mark.asyncio
async def test_readdir_unrecognized_path_raises(accessor, index):
    # Returning [] for an unknown path made `ls` and `tree` report a bogus path
    # as real-but-empty, and left `rg` without a message.
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(vfs_path="__nf_missing__",
                     virtual="/__nf_missing__",
                     directory="/__nf_missing__"), index)


@pytest.mark.asyncio
async def test_readdir_unrecognized_nested_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(vfs_path="workspaces/w/nope/deeper",
                     virtual="/workspaces/w/nope/deeper",
                     directory="/workspaces/w/nope/deeper"), index)
