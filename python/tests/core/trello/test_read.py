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
from mirage.core.trello.config import TrelloConfig
from mirage.core.trello.read import read
from mirage.types import FileStat, FileType, PathSpec
from mirage.vfs.trello import TrelloVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="key", api_token="token"))


# The directory a read is under, as the mount hands its row: a read
# proves the file's directory exists through it before fetching by the
# ids in the path.
DIR = FileStat(name="dir", type=FileType.DIRECTORY)


def _mounted(accessor: TrelloAccessor) -> Workspace:
    return Workspace({"/trello/": vfs_over(TrelloVFS, accessor)})


def _at(path: str) -> PathSpec:
    return PathSpec.from_str_path("/trello" + path)


@pytest.mark.asyncio
async def test_read_workspace_json(accessor):
    workspaces = [{"id": "ws1", "displayName": "Engineering", "name": "eng"}]
    with patch(
        "mirage.core.trello.read.list_workspaces",
        new_callable=AsyncMock,
        return_value=workspaces,
    ):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/workspaces/Engineering__ws1/workspace.json"
            ),
            parent=DIR,
        )
    payload = json.loads(result)
    assert payload["workspace_id"] == "ws1"
    assert payload["workspace_name"] == "Engineering"


@pytest.mark.asyncio
async def test_read_card_json(accessor):
    card = {
        "id": "c1",
        "name": "Fix login",
        "idBoard": "b1",
        "idList": "l1",
        "idMembers": ["m1"],
        "labels": [{"id": "lb1", "name": "bug"}],
        "due": "2026-04-10",
        "dueComplete": False,
        "closed": False,
        "desc": "Login is broken",
        "shortUrl": "https://trello.com/c/abc",
        "members": [{"id": "m1", "username": "alice"}],
    }
    with patch(
        "mirage.core.trello.read.get_card",
        new_callable=AsyncMock,
        return_value=card,
    ):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
                "/lists/Backlog__l1/cards/Fix_login__c1/card.json"
            ),
            parent=DIR,
        )
    payload = json.loads(result)
    assert payload["card_id"] == "c1"
    assert payload["card_name"] == "Fix login"


@pytest.mark.asyncio
async def test_read_comments_jsonl(accessor):
    comments = [
        {
            "id": "act1",
            "date": "2026-04-05T10:00:00Z",
            "memberCreator": {"id": "m1", "fullName": "Alice"},
            "data": {"text": "This needs fixing"},
        }
    ]
    with patch(
        "mirage.core.trello.read.list_card_comments",
        new_callable=AsyncMock,
        return_value=comments,
    ):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/workspaces/Engineering__ws1/boards/Product_Roadmap__b1"
                "/lists/Backlog__l1/cards/Fix_login__c1/comments.jsonl"
            ),
            parent=DIR,
        )
    line = json.loads(result.decode().strip())
    assert line["comment_id"] == "act1"
    assert line["card_id"] == "c1"


@pytest.mark.asyncio
async def test_read_missing_path(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, PathSpec.from_str_path("/nonexistent/path"))


WS1 = {"id": "ws1", "displayName": "Engineering", "name": "eng"}
WS2 = {"id": "ws2", "displayName": "Finance", "name": "fin"}
B1 = {"id": "b1", "name": "Product Roadmap"}
B2 = {"id": "b2", "name": "Secret"}
SECRET = "/workspaces/Engineering__ws1/boards/Secret__b2"


@pytest.mark.asyncio
async def test_a_board_outside_board_ids_is_absent_on_every_surface():
    """The listing drops a board ``board_ids`` leaves out, and the read
    used to go straight to the id in the path: ``cat`` served a board
    ``ls`` and ``stat`` both reported absent."""
    accessor = TrelloAccessor(
        TrelloConfig(api_key="key", api_token="token", board_ids=["b1"])
    )
    get_board = AsyncMock(
        side_effect=lambda accessor, board_id: {"b1": B1, "b2": B2}[board_id]
    )
    get_card = AsyncMock(return_value={"id": "c9", "name": "Payroll"})
    ws = _mounted(accessor)
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            AsyncMock(return_value=[WS1]),
        ),
        patch(
            "mirage.core.trello.readdir.list_workspace_boards",
            AsyncMock(return_value=[B1, B2]),
        ),
        patch("mirage.core.trello.read.get_board", get_board),
        patch("mirage.core.trello.read.get_card", get_card),
    ):
        board_json = _at(SECRET + "/board.json")
        for op in ("read", "stat"):
            with pytest.raises(FileNotFoundError):
                await ws.dispatch(op, board_json)
        with pytest.raises(FileNotFoundError):
            await ws.dispatch("readdir", _at(SECRET))
        with pytest.raises(FileNotFoundError):
            await ws.dispatch(
                "read",
                _at(SECRET + "/lists/Todo__l9/cards/Payroll__c9/card.json"),
            )
        get_board.assert_not_awaited()
        get_card.assert_not_awaited()
        scoped, _ = await ws.dispatch(
            "read",
            _at(
                "/workspaces/Engineering__ws1/boards"
                "/Product_Roadmap__b1/board.json"
            ),
        )
    assert json.loads(scoped)["board_id"] == "b1"


@pytest.mark.asyncio
async def test_a_workspace_outside_workspace_id_is_absent_to_read():
    accessor = TrelloAccessor(
        TrelloConfig(api_key="key", api_token="token", workspace_id="ws1")
    )
    ws = _mounted(accessor)
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            AsyncMock(return_value=[WS1, WS2]),
        ),
        patch(
            "mirage.core.trello.read.list_workspaces",
            AsyncMock(return_value=[WS1, WS2]),
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await ws.dispatch(
                "read", _at("/workspaces/Finance__ws2/workspace.json")
            )
        scoped, _ = await ws.dispatch(
            "read", _at("/workspaces/Engineering__ws1/workspace.json")
        )
    assert json.loads(scoped)["workspace_id"] == "ws1"


@pytest.mark.asyncio
async def test_a_dot_led_board_title_is_listed_and_addressable():
    """``sanitize_name`` kept a leading dot, so a board titled ``.plan``
    rendered ``.plan__b1``: the kit drops a dot-led name from the listing
    and classifies it as hidden, so the board was neither listed nor
    readable, with no error anywhere."""
    accessor = TrelloAccessor(TrelloConfig(api_key="key", api_token="token"))
    ws = _mounted(accessor)
    board = {"id": "b1", "name": ".plan"}
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            AsyncMock(return_value=[WS1]),
        ),
        patch(
            "mirage.core.trello.readdir.list_workspace_boards",
            AsyncMock(return_value=[board]),
        ),
        patch(
            "mirage.core.trello.read.get_board", AsyncMock(return_value=board)
        ),
    ):
        listed, _ = await ws.dispatch(
            "readdir", _at("/workspaces/Engineering__ws1/boards")
        )
        assert listed == [
            "/trello/workspaces/Engineering__ws1/boards/plan__b1"
        ]
        board_json = PathSpec.from_str_path(listed[0] + "/board.json")
        row, _ = await ws.dispatch("stat", board_json)
        assert row.name == "board.json"
        data, _ = await ws.dispatch("read", board_json)
        payload = json.loads(data)
    assert payload["board_name"] == ".plan"
