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

import functools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.builtin.trello._scope import (
    require_board,
    require_card,
    require_list,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandSpec
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
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

Runner = Callable[[TrelloAccessor, list[str], FlagView], Awaitable[bytes]]


@dataclass(frozen=True, slots=True)
class TrelloRead:
    name: str
    runner: Runner
    spec: CommandSpec


SPEC_NONE = CommandSpec()
SPEC_ARG = CommandSpec(arguments=(Argument("texts", nargs="*", metavar=""),))


def _first(texts: list[str], label: str) -> str:
    if not texts:
        raise ValueError(f"{label} is required")
    return texts[0]


async def _run_board_list(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    boards: list[dict[str, JsonValue]] = []
    for workspace in await filtered_workspaces(accessor):
        for board in await filtered_boards(accessor, workspace["id"]):
            boards.append(normalize_board(board))
    return to_json_bytes(boards)


async def _run_board_show(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    board = await get_board(accessor.config, board_id, session=accessor.pool)
    return to_json_bytes(normalize_board(board))


async def _run_board_members(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    config = accessor.config
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    members = await list_board_members(config, board_id, session=accessor.pool)
    return to_json_bytes([normalize_member(member) for member in members])


async def _run_list_list(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    config = accessor.config
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    lists = await list_board_lists(config, board_id, session=accessor.pool)
    return to_json_bytes([normalize_list(lst) for lst in lists])


async def _run_label_list(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    config = accessor.config
    board_id = _first(texts, "board id")
    await require_board(accessor, board_id)
    labels = await list_board_labels(config, board_id, session=accessor.pool)
    return to_json_bytes([normalize_label(label) for label in labels])


async def _run_card_list(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    config = accessor.config
    list_id = _first(texts, "list id")
    await require_list(accessor, list_id)
    cards = await list_list_cards(config, list_id, session=accessor.pool)
    return to_json_bytes([normalize_card(card) for card in cards])


async def _run_card_show(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    card_id = _first(texts, "card id")
    await require_card(accessor, card_id)
    card = await get_card(accessor.config, card_id, session=accessor.pool)
    return to_json_bytes(normalize_card(card))


async def _run_card_comments(
    accessor: TrelloAccessor, texts: list[str], fl: FlagView
) -> bytes:
    config = accessor.config
    card_id = _first(texts, "card id")
    await require_card(accessor, card_id)
    comments = await list_card_comments(config, card_id, session=accessor.pool)
    return to_json_bytes(
        [normalize_comment(comment, card_id=card_id) for comment in comments]
    )


TRELLO_READS: tuple[TrelloRead, ...] = (
    TrelloRead("trello board list", _run_board_list, SPEC_NONE),
    TrelloRead("trello board show", _run_board_show, SPEC_ARG),
    TrelloRead("trello board members", _run_board_members, SPEC_ARG),
    TrelloRead("trello list list", _run_list_list, SPEC_ARG),
    TrelloRead("trello label list", _run_label_list, SPEC_ARG),
    TrelloRead("trello card list", _run_card_list, SPEC_ARG),
    TrelloRead("trello card show", _run_card_show, SPEC_ARG),
    TrelloRead("trello card comments", _run_card_comments, SPEC_ARG),
)


async def _dispatch(
    entry: TrelloRead,
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=entry.spec)
    data = await entry.runner(accessor, list(texts), fl)
    return yield_bytes(data), IOResult()


def make_trello_read_commands() -> list[Callable[..., Any]]:
    commands: list[Callable[..., Any]] = []
    for entry in TRELLO_READS:
        commands.append(
            command(entry.name, vfs="trello", spec=entry.spec)(
                functools.partial(_dispatch, entry)
            )
        )
    return commands
