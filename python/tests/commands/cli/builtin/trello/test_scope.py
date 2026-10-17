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
from mirage.commands.cli.builtin.trello.scope import (
    require_board,
    require_card,
    require_list,
)
from mirage.core.trello.config import TrelloConfig


def _accessor(**knobs) -> TrelloAccessor:
    return TrelloAccessor(TrelloConfig(api_key="k", api_token="t", **knobs))


@pytest.mark.asyncio
async def test_an_unnarrowed_install_admits_every_id_without_a_call():
    accessor = _accessor()
    with (
        patch(
            "mirage.commands.cli.builtin.trello.scope.get_card",
            new_callable=AsyncMock,
        ) as get_card,
        patch(
            "mirage.commands.cli.builtin.trello.scope.get_list",
            new_callable=AsyncMock,
        ) as get_list,
    ):
        await require_board(accessor, "b_any")
        await require_list(accessor, "l_any")
        await require_card(accessor, "c_any")
    get_card.assert_not_awaited()
    get_list.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_id_on_a_board_in_scope_is_admitted():
    accessor = _accessor(board_ids=["b_in"])
    on_board = AsyncMock(return_value={"idBoard": "b_in"})
    with (
        patch(
            "mirage.commands.cli.builtin.trello.scope.get_card", new=on_board
        ),
        patch(
            "mirage.commands.cli.builtin.trello.scope.get_list", new=on_board
        ),
    ):
        await require_board(accessor, "b_in")
        await require_list(accessor, "l1")
        await require_card(accessor, "c1")
    assert on_board.await_count == 2


@pytest.mark.asyncio
async def test_a_record_without_a_board_is_refused():
    accessor = _accessor(board_ids=["b_in"])
    with patch(
        "mirage.commands.cli.builtin.trello.scope.get_card",
        new_callable=AsyncMock,
        return_value={"id": "c1"},
    ):
        with pytest.raises(
            ValueError, match="^card c1 is outside the configured scope$"
        ):
            await require_card(accessor, "c1")
