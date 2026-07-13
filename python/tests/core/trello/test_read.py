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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.read import read
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="key", api_token="token"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_workspace_json(accessor, index):
    workspaces = [{"id": "ws1", "displayName": "Engineering", "name": "eng"}]
    with patch("mirage.core.trello.read.list_workspaces",
               new_callable=AsyncMock,
               return_value=workspaces):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/workspaces/Engineering__ws1/workspace.json"),
            index,
        )
    payload = json.loads(result)
    assert payload["workspace_id"] == "ws1"
    assert payload["workspace_name"] == "Engineering"


@pytest.mark.asyncio
async def test_read_card_json(accessor, index):
    card = {
        "id": "c1",
        "name": "Fix login",
        "idBoard": "b1",
        "idList": "l1",
        "idMembers": ["m1"],
        "labels": [{
            "id": "lb1",
            "name": "bug"
        }],
        "due": "2026-04-10",
        "dueComplete": False,
        "closed": False,
        "desc": "Login is broken",
        "shortUrl": "https://trello.com/c/abc",
        "members": [{
            "id": "m1",
            "username": "alice"
        }],
    }
    with patch("mirage.core.trello.read.get_card",
               new_callable=AsyncMock,
               return_value=card):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
                "/lists/Backlog__l1/cards/Fix_login__c1/card.json"),
            index,
        )
    payload = json.loads(result)
    assert payload["card_id"] == "c1"
    assert payload["card_name"] == "Fix login"


@pytest.mark.asyncio
async def test_read_comments_jsonl(accessor, index):
    comments = [{
        "id": "act1",
        "date": "2026-04-05T10:00:00Z",
        "memberCreator": {
            "id": "m1",
            "fullName": "Alice"
        },
        "data": {
            "text": "This needs fixing"
        },
    }]
    with patch("mirage.core.trello.read.list_card_comments",
               new_callable=AsyncMock,
               return_value=comments):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
                "/lists/Backlog__l1/cards/Fix_login__c1/comments.jsonl"),
            index,
        )
    line = json.loads(result.decode().strip())
    assert line["comment_id"] == "act1"
    assert line["card_id"] == "c1"


@pytest.mark.asyncio
async def test_read_missing_path(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, PathSpec.from_str_path("/nonexistent/path"),
                   index)
