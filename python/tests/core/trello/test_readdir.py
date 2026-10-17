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
from mirage.core.trello.config import TrelloConfig
from mirage.core.trello.normalize import (
    normalize_card,
    normalize_workspace,
    to_json_bytes,
)
from mirage.core.trello.readdir import (
    board_in_scope,
    filtered_boards,
    filtered_workspaces,
    readdir,
)
from mirage.types import PathSpec
from mirage.vfs.trello import TrelloVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


@pytest.fixture
def accessor():
    return TrelloAccessor(TrelloConfig(api_key="k", api_token="t"))


def _mounted(accessor: TrelloAccessor) -> Workspace:
    return Workspace({"/trello/": vfs_over(TrelloVFS, accessor)})


def _at(path: str) -> PathSpec:
    return PathSpec.from_str_path("/trello" + path)


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert [row.name for row in result] == ["workspaces"]


@pytest.mark.asyncio
async def test_readdir_workspace_dir_carries_sized_workspace_json(accessor):
    ws = {"id": "ws1", "displayName": "Engineering"}
    with patch(
        "mirage.core.trello.readdir.list_workspaces",
        new_callable=AsyncMock,
        return_value=[ws],
    ):
        (row,) = await readdir(
            accessor,
            PathSpec(
                vfs_path="workspaces",
                virtual="/workspaces",
                directory="/workspaces",
            ),
        )
    workspace_json, boards = await readdir(
        accessor,
        PathSpec(
            vfs_path="workspaces/Engineering__ws1",
            virtual="/workspaces/Engineering__ws1",
            directory="/workspaces/Engineering__ws1",
        ),
        row,
    )
    assert (workspace_json.name, boards.name) == ("workspace.json", "boards")
    assert workspace_json.size == len(to_json_bytes(normalize_workspace(ws)))


@pytest.mark.asyncio
async def test_readdir_card_dir_carries_sized_card_json(accessor):
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
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            new_callable=AsyncMock,
            return_value=[{"id": "ws1", "displayName": "Engineering"}],
        ),
        patch(
            "mirage.core.trello.readdir.list_workspace_boards",
            new_callable=AsyncMock,
            return_value=[{"id": "b1", "name": "Roadmap"}],
        ),
        patch(
            "mirage.core.trello.readdir.list_board_lists",
            new_callable=AsyncMock,
            return_value=[{"id": "l1", "name": "Doing"}],
        ),
        patch(
            "mirage.core.trello.readdir.list_list_cards",
            new_callable=AsyncMock,
            return_value=[card],
        ),
    ):
        listed, _ = await _mounted(accessor).dispatch(
            "readdir", _at(f"{base}/cards/Fix_login__c1")
        )
        card_json, _ = await _mounted(accessor).dispatch(
            "stat", _at(f"{base}/cards/Fix_login__c1/card.json")
        )
        comments, _ = await _mounted(accessor).dispatch(
            "stat", _at(f"{base}/cards/Fix_login__c1/comments.jsonl")
        )
    assert listed == [
        f"/trello{base}/cards/Fix_login__c1/card.json",
        f"/trello{base}/cards/Fix_login__c1/comments.jsonl",
    ]
    assert card_json.size == len(to_json_bytes(normalize_card(card)))
    assert comments.size is None


@pytest.mark.asyncio
async def test_readdir_traversal_never_refetches_a_listing(accessor):
    # Entering a directory a traversal just listed is handed the row the
    # parent listing kept; the old find chain re-fetched every ancestor
    # listing per directory, which made a recursive walk quadratic in
    # listing payloads.
    ws = _mounted(accessor)
    cards = [{"id": f"c{i}", "name": f"Card {i}"} for i in range(3)]
    base = "/workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1"
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            new_callable=AsyncMock,
            return_value=[{"id": "ws1", "displayName": "Engineering"}],
        ) as ws_mock,
        patch(
            "mirage.core.trello.readdir.list_workspace_boards",
            new_callable=AsyncMock,
            return_value=[{"id": "b1", "name": "Roadmap"}],
        ) as boards_mock,
        patch(
            "mirage.core.trello.readdir.list_board_lists",
            new_callable=AsyncMock,
            return_value=[{"id": "l1", "name": "Doing"}],
        ) as lists_mock,
        patch(
            "mirage.core.trello.readdir.list_list_cards",
            new_callable=AsyncMock,
            return_value=cards,
        ) as cards_mock,
    ):
        listed, _ = await ws.dispatch("readdir", _at(f"{base}/cards"))
        for card_dir in listed:
            await ws.dispatch("readdir", PathSpec.from_str_path(card_dir))
    assert ws_mock.await_count == 1
    assert boards_mock.await_count == 1
    assert lists_mock.await_count == 1
    assert cards_mock.await_count == 1


@pytest.mark.asyncio
async def test_readdir_unknown_workspace_raises(accessor):
    # No listed workspace carries the typed `label__id` dirname, so the
    # mount hands no row and the kit reports ENOENT.
    with patch(
        "mirage.core.trello.readdir.list_workspaces",
        new_callable=AsyncMock,
        return_value=[{"id": "ws1", "displayName": "Engineering"}],
    ):
        with pytest.raises(FileNotFoundError):
            await _mounted(accessor).dispatch(
                "readdir", _at("/workspaces/Ghost__nope/boards")
            )


@pytest.mark.asyncio
async def test_readdir_unrecognized_path_raises(accessor):
    # Returning [] for an unknown path made `ls` and `tree` report a bogus path
    # as real-but-empty, and left `rg` without a message.
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="__nf_missing__",
                virtual="/__nf_missing__",
                directory="/__nf_missing__",
            ),
        )


@pytest.mark.asyncio
async def test_readdir_unrecognized_nested_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="workspaces/w/nope/deeper",
                virtual="/workspaces/w/nope/deeper",
                directory="/workspaces/w/nope/deeper",
            ),
        )


def _scoped(**knobs) -> TrelloAccessor:
    return TrelloAccessor(TrelloConfig(api_key="k", api_token="t", **knobs))


@pytest.mark.asyncio
async def test_board_in_scope_admits_every_id_on_an_unnarrowed_mount():
    with patch(
        "mirage.core.trello.readdir.get_board", new_callable=AsyncMock
    ) as get_board:
        assert await board_in_scope(_scoped(), "b_any") is True
    get_board.assert_not_awaited()


@pytest.mark.asyncio
async def test_board_in_scope_holds_an_id_to_board_ids_without_a_call():
    accessor = _scoped(board_ids=["b_in"])
    with patch(
        "mirage.core.trello.readdir.get_board", new_callable=AsyncMock
    ) as get_board:
        assert await board_in_scope(accessor, "b_in") is True
        assert await board_in_scope(accessor, "b_out") is False
        assert await board_in_scope(accessor, "") is False
    get_board.assert_not_awaited()


@pytest.mark.asyncio
async def test_board_in_scope_holds_an_id_to_workspace_id():
    accessor = _scoped(workspace_id="ws1")
    boards = {
        "b_in": {"id": "b_in", "idOrganization": "ws1"},
        "b_out": {"id": "b_out", "idOrganization": "ws2"},
    }

    async def fake_board(accessor, board_id):
        return boards[board_id]

    with patch("mirage.core.trello.readdir.get_board", new=fake_board):
        assert await board_in_scope(accessor, "b_in") is True
        assert await board_in_scope(accessor, "b_out") is False


@pytest.mark.asyncio
async def test_filtered_boards_and_workspaces_apply_both_knobs():
    accessor = _scoped(workspace_id="ws1", board_ids=["b1"])
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            new_callable=AsyncMock,
            return_value=[{"id": "ws1"}, {"id": "ws2"}],
        ),
        patch(
            "mirage.core.trello.readdir.list_workspace_boards",
            new_callable=AsyncMock,
            return_value=[{"id": "b1"}, {"id": "b2"}],
        ),
    ):
        assert await filtered_workspaces(accessor) == [{"id": "ws1"}]
        assert await filtered_boards(accessor, "ws1") == [{"id": "b1"}]
