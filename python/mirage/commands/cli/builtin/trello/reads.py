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
from mirage.commands.cli.builtin.trello.scope import (
    require_board,
    require_card,
    require_list,
)
from mirage.commands.config import Context
from mirage.core.trello.client import (
    get_board,
    get_card,
    list_board_labels,
    list_board_lists,
    list_board_members,
    list_card_comments,
    list_list_cards,
)
from mirage.core.trello.normalize import (
    normalize_board,
    normalize_card,
    normalize_comment,
    normalize_label,
    normalize_list,
    normalize_member,
    to_json_bytes,
)
from mirage.core.trello.readdir import filtered_boards, filtered_workspaces
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec


def _first(texts: list[str], label: str) -> str:
    if not texts:
        raise ValueError(f"{label} is required")
    return texts[0]


async def board_list(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    boards: list[dict[str, JsonValue]] = []
    for workspace in await filtered_workspaces(accessor):
        for board in await filtered_boards(accessor, workspace["id"]):
            boards.append(normalize_board(board))
    return to_json_bytes(boards), IOResult()


async def board_show(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    board = await get_board(accessor, board_id)
    return to_json_bytes(normalize_board(board)), IOResult()


async def board_members(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    members = await list_board_members(accessor, board_id)
    return to_json_bytes(
        [normalize_member(member) for member in members]
    ), IOResult()


async def list_list(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    lists = await list_board_lists(accessor, board_id)
    return to_json_bytes([normalize_list(lst) for lst in lists]), IOResult()


async def label_list(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    labels = await list_board_labels(accessor, board_id)
    return to_json_bytes(
        [normalize_label(label) for label in labels]
    ), IOResult()


async def card_list(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    list_id = _first(texts, "list id")
    await require_list(accessor, list_id)
    cards = await list_list_cards(accessor, list_id)
    return to_json_bytes([normalize_card(card) for card in cards]), IOResult()


async def card_show(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    card_id = _first(texts, "card id")
    await require_card(accessor, card_id)
    card = await get_card(accessor, card_id)
    return to_json_bytes(normalize_card(card)), IOResult()


async def card_comments(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    card_id = _first(texts, "card id")
    await require_card(accessor, card_id)
    comments = await list_card_comments(accessor, card_id)
    return to_json_bytes(
        [normalize_comment(comment, card_id=card_id) for comment in comments]
    ), IOResult()
