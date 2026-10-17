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

from mirage.accessor.trello import TrelloAccessor
from mirage.core.trello.client import get_card, get_list
from mirage.core.trello.readdir import board_in_scope, scope_is_narrowed


def _outside(kind: str, ident: str) -> ValueError:
    return ValueError(f"{kind} {ident} is outside this mount's scope")


async def require_board(accessor: TrelloAccessor, board_id: str) -> None:
    """Refuse a board the mount's scope leaves out.

    A verb reaches the API by the id it is handed, not through the
    listing, so without this ``workspace_id`` and ``board_ids`` narrow
    only the file tree.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
        board_id (str): The board's id.
    """
    if not await board_in_scope(accessor, board_id):
        raise _outside("board", board_id)


async def require_list(accessor: TrelloAccessor, list_id: str) -> None:
    """Refuse a list on a board the mount's scope leaves out.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
        list_id (str): The list's id.
    """
    if not scope_is_narrowed(accessor):
        return
    lst = await get_list(accessor, list_id)
    if not await board_in_scope(accessor, str(lst.get("idBoard") or "")):
        raise _outside("list", list_id)


async def require_card(accessor: TrelloAccessor, card_id: str) -> None:
    """Refuse a card on a board the mount's scope leaves out.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
        card_id (str): The card's id.
    """
    if not scope_is_narrowed(accessor):
        return
    card = await get_card(accessor, card_id)
    if not await board_in_scope(accessor, str(card.get("idBoard") or "")):
        raise _outside("card", card_id)
