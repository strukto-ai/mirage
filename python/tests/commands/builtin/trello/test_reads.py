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
from mirage.commands.builtin.trello.reads import TRELLO_READS, TrelloRead
from mirage.commands.spec.flag_view import FlagView
from mirage.vfs.trello.config import TrelloConfig

# An unroutable base_url: a read the scope guard failed to stop would
# reach this and fail with a connection error, never the refusal.
_BASE = "http://127.0.0.1:9"

BOARD_READS = [
    "trello board show",
    "trello board members",
    "trello list list",
    "trello label list",
]


def _accessor(**knobs) -> TrelloAccessor:
    return TrelloAccessor(
        TrelloConfig(api_key="k", api_token="t", base_url=_BASE, **knobs)
    )


def _read(name: str) -> TrelloRead:
    return next(entry for entry in TRELLO_READS if entry.name == name)


async def _run(name: str, accessor: TrelloAccessor, texts: list[str]) -> bytes:
    entry = _read(name)
    return await entry.runner(accessor, texts, FlagView({}, spec=entry.spec))


async def _on_board_out(accessor, ident):
    return {"id": ident, "idBoard": "b_out"}


@pytest.mark.asyncio
async def test_board_list_shows_only_the_boards_the_mount_lists():
    accessor = _accessor(workspace_id="ws1", board_ids=["b1"])
    with (
        patch(
            "mirage.core.trello.readdir.list_workspaces",
            new_callable=AsyncMock,
            return_value=[{"id": "ws1"}, {"id": "ws2"}],
        ),
        patch(
            "mirage.core.trello.readdir.list_workspace_boards",
            new_callable=AsyncMock,
            return_value=[
                {"id": "b1", "name": "In"},
                {"id": "b2", "name": "Out"},
            ],
        ) as boards,
    ):
        out = await _run("trello board list", accessor, [])
    assert [b["board_name"] for b in json.loads(out)] == ["In"]
    assert [call.args[1] for call in boards.await_args_list] == ["ws1"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name", BOARD_READS)
async def test_a_board_read_refuses_a_board_outside_the_scope(name):
    with pytest.raises(
        ValueError, match="^board b_out is outside this mount's scope$"
    ):
        await _run(name, _accessor(board_ids=["b_in"]), ["b_out"])


@pytest.mark.asyncio
async def test_card_list_refuses_a_list_on_a_board_outside_the_scope():
    with patch(
        "mirage.commands.builtin.trello._scope.get_list", new=_on_board_out
    ):
        with pytest.raises(
            ValueError, match="^list l1 is outside this mount's scope$"
        ):
            await _run(
                "trello card list", _accessor(board_ids=["b_in"]), ["l1"]
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["trello card show", "trello card comments"])
async def test_a_card_read_refuses_a_card_on_a_board_outside_the_scope(name):
    with (
        patch(
            "mirage.commands.builtin.trello._scope.get_card", new=_on_board_out
        ),
        patch(
            "mirage.core.trello.readdir.get_board",
            new_callable=AsyncMock,
            return_value={"id": "b_out", "idOrganization": "ws2"},
        ),
    ):
        with pytest.raises(
            ValueError, match="^card c1 is outside this mount's scope$"
        ):
            await _run(name, _accessor(workspace_id="ws1"), ["c1"])


@pytest.mark.asyncio
async def test_a_card_read_inside_the_scope_is_answered():
    card = {"id": "c1", "name": "Ship", "idBoard": "b_in"}
    with (
        patch(
            "mirage.commands.builtin.trello._scope.get_card",
            new_callable=AsyncMock,
            return_value=card,
        ),
        patch(
            "mirage.commands.builtin.trello.reads.get_card",
            new_callable=AsyncMock,
            return_value=card,
        ),
    ):
        out = await _run(
            "trello card show", _accessor(board_ids=["b_in"]), ["c1"]
        )
    assert json.loads(out)["card_name"] == "Ship"
