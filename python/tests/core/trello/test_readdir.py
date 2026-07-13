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
from mirage.core.trello.readdir import readdir
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="key", api_token="token"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(accessor, PathSpec.from_str_path("/"), index)
    assert result == ["/workspaces"]


@pytest.mark.asyncio
async def test_readdir_root_with_prefix(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path=mount_key("trello/", "trello"),
                 virtual="trello/",
                 directory="trello/"), index)
    assert result == ["trello/workspaces"]


@pytest.mark.asyncio
async def test_readdir_workspaces(accessor, index):
    workspaces = [{"id": "ws1", "displayName": "Engineering", "name": "eng"}]
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=workspaces):
        result = await readdir(accessor, PathSpec.from_str_path("/workspaces"),
                               index)
    assert result == ["/workspaces/Engineering__ws1"]


@pytest.mark.asyncio
async def test_readdir_workspaces_keeps_prefix_on_warm_cache_hit(
        accessor, index):
    workspaces = [{"id": "ws1", "displayName": "Engineering", "name": "eng"}]
    spec = PathSpec(resource_path=mount_key("trello/workspaces", "trello"),
                    virtual="trello/workspaces",
                    directory="trello/workspaces")
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=workspaces):
        cold = await readdir(accessor, spec, index)
        warm = await readdir(accessor, spec, index)
    assert cold == ["trello/workspaces/Engineering__ws1"]
    assert warm == cold


@pytest.mark.asyncio
async def test_readdir_workspace_entry(accessor, index):
    await index.put(
        "/workspaces/Engineering__ws1",
        IndexEntry(
            id="ws1",
            name="Engineering",
            resource_type="trello/workspace",
            remote_time="",
            vfs_name="Engineering__ws1",
        ),
    )
    result = await readdir(
        accessor, PathSpec.from_str_path("/workspaces/Engineering__ws1"),
        index)
    assert result == [
        "/workspaces/Engineering__ws1/workspace.json",
        "/workspaces/Engineering__ws1/boards",
    ]


@pytest.mark.asyncio
async def test_readdir_boards(accessor, index):
    await index.put(
        "/workspaces/Engineering__ws1",
        IndexEntry(
            id="ws1",
            name="Engineering",
            resource_type="trello/workspace",
            remote_time="",
            vfs_name="Engineering__ws1",
        ),
    )
    boards = [{"id": "b1", "name": "Product Roadmap", "dateLastActivity": ""}]
    with patch("mirage.core.trello.readdir.list_workspace_boards",
               new_callable=AsyncMock,
               return_value=boards):
        result = await readdir(
            accessor,
            PathSpec.from_str_path("/workspaces/Engineering__ws1/boards"),
            index)
    assert result == [
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
    ]


@pytest.mark.asyncio
async def test_readdir_board_entry(accessor, index):
    await index.put(
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1",
        IndexEntry(
            id="b1",
            name="Product Roadmap",
            resource_type="trello/board",
            remote_time="",
            vfs_name="Product_Roadmap__b1",
        ),
    )
    result = await readdir(
        accessor,
        PathSpec.from_str_path(
            "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"),
        index,
    )
    assert result == [
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1/board.json",
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1/members",
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1/labels",
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1/lists",
    ]


@pytest.mark.asyncio
async def test_readdir_card_folder(accessor, index):
    await index.put(
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
        "/lists/Backlog__l1/cards/Fix_login__c1",
        IndexEntry(
            id="c1",
            name="Fix login",
            resource_type="trello/card",
            remote_time="",
            vfs_name="Fix_login__c1",
        ),
    )
    result = await readdir(
        accessor,
        PathSpec.from_str_path(
            "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
            "/lists/Backlog__l1/cards/Fix_login__c1"),
        index,
    )
    assert result == [
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
        "/lists/Backlog__l1/cards/Fix_login__c1/card.json",
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
        "/lists/Backlog__l1/cards/Fix_login__c1/comments.jsonl",
    ]
