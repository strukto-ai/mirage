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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.core.trello import readdir as trello_readdir
from mirage.core.trello.normalize import normalize_card, to_json_bytes
from mirage.core.trello.stat import stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.trello import TrelloVFS
from mirage.vfs.trello.config import TrelloConfig
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

CARD = {
    "id": "c1",
    "name": "Fix login",
    "desc": "broken",
    "dateLastActivity": "2026-04-06T00:00:00.000Z",
}

CARD_DIR = (
    "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
    "/lists/Backlog__l1/cards/Fix_login__c1"
)


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="key", api_token="token"))


@pytest.fixture(autouse=True)
def _tree(monkeypatch):
    listed = {
        "list_workspaces": [{"id": "ws1", "displayName": "Engineering"}],
        "list_workspace_boards": [
            {
                "id": "b1",
                "name": "Product Roadmap",
                "dateLastActivity": "2026-04-05T00:00:00.000Z",
            }
        ],
        "list_board_lists": [{"id": "l1", "name": "Backlog"}],
        "list_list_cards": [CARD],
    }
    for name, rows in listed.items():
        monkeypatch.setattr(trello_readdir, name, AsyncMock(return_value=rows))


async def _stat_at(accessor: TrelloAccessor, path: str) -> FileStat:
    ws = Workspace({"/trello/": vfs_over(TrelloVFS, accessor)})
    row, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/trello" + path)
    )
    return row


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(accessor, PathSpec.from_str_path("/"))
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_workspaces(accessor):
    result = await stat(accessor, PathSpec.from_str_path("/workspaces"))
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_workspace_entry(accessor):
    result = await _stat_at(accessor, "/workspaces/Engineering__ws1")
    assert result.type == FileType.DIRECTORY
    assert result.extra["workspace_id"] == "ws1"


@pytest.mark.asyncio
async def test_stat_board_entry(accessor):
    result = await _stat_at(
        accessor, "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
    )
    assert result.type == FileType.DIRECTORY
    assert result.extra["board_id"] == "b1"
    assert result.modified == "2026-04-05T00:00:00.000Z"


@pytest.mark.asyncio
async def test_stat_card_json(accessor):
    result = await _stat_at(accessor, CARD_DIR + "/card.json")
    assert result.content == ContentType.JSON
    assert result.size == len(to_json_bytes(normalize_card(CARD)))
    assert result.extra["card_id"] == "c1"


@pytest.mark.asyncio
async def test_stat_comments_jsonl(accessor):
    result = await _stat_at(accessor, CARD_DIR + "/comments.jsonl")
    assert result.content == ContentType.TEXT
    assert result.size is None


@pytest.mark.asyncio
async def test_stat_missing_path(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec.from_str_path("/nonexistent/path"))
