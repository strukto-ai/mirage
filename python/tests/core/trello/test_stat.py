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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.stat import stat
from mirage.resource.trello.config import TrelloConfig
from mirage.types import FileType


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="key", api_token="token"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, "/", index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_workspaces(accessor, index):
    result = await stat(accessor, "/workspaces", index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_workspace_entry(accessor, index):
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
    result = await stat(accessor, "/workspaces/Engineering__ws1", index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["workspace_id"] == "ws1"


@pytest.mark.asyncio
async def test_stat_board_entry(accessor, index):
    await index.put(
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1",
        IndexEntry(
            id="b1",
            name="Product Roadmap",
            resource_type="trello/board",
            remote_time="2026-04-05T00:00:00.000Z",
            vfs_name="Product_Roadmap__b1",
        ),
    )
    result = await stat(
        accessor,
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1",
        index,
    )
    assert result.type == FileType.DIRECTORY
    assert result.extra["board_id"] == "b1"
    assert result.modified == "2026-04-05T00:00:00.000Z"


@pytest.mark.asyncio
async def test_stat_card_json(accessor, index):
    result = await stat(
        accessor,
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
        "/lists/Backlog__l1/cards/Fix_login__c1/card.json",
        index,
    )
    assert result.type == FileType.JSON


@pytest.mark.asyncio
async def test_stat_comments_jsonl(accessor, index):
    result = await stat(
        accessor,
        "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
        "/lists/Backlog__l1/cards/Fix_login__c1/comments.jsonl",
        index,
    )
    assert result.type == FileType.TEXT


@pytest.mark.asyncio
async def test_stat_missing_path(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, "/nonexistent/path", index)
