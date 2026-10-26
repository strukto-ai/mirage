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

from typing import Any

from mirage.accessor.trello import TrelloAccessor
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat
from mirage.core.trello.client import (
    get_board,
    list_board_labels,
    list_board_lists,
    list_board_members,
    list_list_cards,
    list_workspace_boards,
    list_workspaces,
)
from mirage.core.trello.normalize import (
    normalize_board,
    normalize_card,
    normalize_label,
    normalize_list,
    normalize_member,
    normalize_workspace,
    to_json_bytes,
    unsearched_text,
)
from mirage.core.trello.pathing import (
    board_dirname,
    card_dirname,
    label_filename,
    list_dirname,
    member_filename,
    workspace_dirname,
)
from mirage.core.trello.scope import detect_scope
from mirage.types import ContentType, FileStat, FileType


async def filtered_workspaces(
    accessor: TrelloAccessor,
) -> list[dict[str, Any]]:
    """The workspaces the mount shows: the member's, narrowed to
    ``workspace_id`` when it is set.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
    """
    workspaces = await list_workspaces(accessor)
    if accessor.config.workspace_id:
        workspaces = [
            w
            for w in workspaces
            if w.get("id") == accessor.config.workspace_id
        ]
    return workspaces


async def filtered_boards(
    accessor: TrelloAccessor, workspace_id: str
) -> list[dict[str, Any]]:
    """A workspace's open boards the mount shows, narrowed to
    ``board_ids`` when it is set.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
        workspace_id (str): The workspace whose boards to list.
    """
    boards = await list_workspace_boards(accessor, workspace_id)
    if accessor.config.board_ids:
        boards = [
            b for b in boards if b.get("id") in accessor.config.board_ids
        ]
    return boards


def scope_is_narrowed(accessor: TrelloAccessor) -> bool:
    """Whether ``workspace_id`` or ``board_ids`` narrows the mount.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
    """
    return bool(accessor.config.workspace_id or accessor.config.board_ids)


async def board_in_scope(accessor: TrelloAccessor, board_id: str) -> bool:
    """Whether the mount's scope admits a board addressed by id.

    The two knobs that narrow the listing narrow an id too: a board
    ``board_ids`` leaves out, or one outside ``workspace_id``, is not
    this mount's to read or write. Unnarrowed, every id is admitted
    without a call; ``workspace_id`` costs one board fetch.

    Args:
        accessor (TrelloAccessor): The mount's accessor.
        board_id (str): The board's id.
    """
    config = accessor.config
    if not scope_is_narrowed(accessor):
        return True
    if not board_id:
        return False
    if config.board_ids and board_id not in config.board_ids:
        return False
    if not config.workspace_id:
        return True
    board = await get_board(accessor, board_id)
    return board.get("idOrganization") == config.workspace_id


WORKSPACE = entry_stat("workspace_id", FileType.DIRECTORY)
WORKSPACE_JSON = entry_stat("workspace_id", ContentType.JSON)
BOARD = entry_stat("board_id", FileType.DIRECTORY)
BOARD_JSON = entry_stat("board_id", ContentType.JSON)
MEMBER = entry_stat("member_id", ContentType.JSON)
LABEL = entry_stat("label_id", ContentType.JSON)
LIST = entry_stat("list_id", FileType.DIRECTORY)
LIST_JSON = entry_stat("list_id", ContentType.JSON)
CARD = entry_stat("card_id", FileType.DIRECTORY)
CARD_JSON = entry_stat("card_id", ContentType.JSON)
COMMENTS = entry_stat("card_id", ContentType.TEXT)


def _dir(name: str) -> FileStat:
    return FileStat(name=name, type=FileType.DIRECTORY)


async def _list_workspaces_dir(
    accessor: TrelloAccessor, match: ScopeMatch
) -> list[FileStat]:
    # workspace.json renders the workspace object this listing already
    # fetched, so its exact size rides the directory's row for the child
    # listing to read back without another call.
    return [
        WORKSPACE(
            workspace_dirname(workspace),
            workspace["id"],
            extra={
                "json_size": len(
                    to_json_bytes(normalize_workspace(workspace))
                ),
            },
        )
        for workspace in await filtered_workspaces(accessor)
    ]


async def _list_workspace(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    return [
        WORKSPACE_JSON(
            "workspace.json",
            match.slots["workspace_id"],
            size=entry.extra.get("json_size"),
        ),
        _dir("boards"),
    ]


async def _list_boards(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    # board.json's normalizer only uses fields the board listing already
    # carries, so its exact size is free here.
    return [
        BOARD(
            board_dirname(board),
            board["id"],
            modified=board.get("dateLastActivity"),
            extra={"json_size": len(to_json_bytes(normalize_board(board)))},
        )
        for board in await filtered_boards(
            accessor, match.slots["workspace_id"]
        )
    ]


async def _list_board(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    return [
        BOARD_JSON(
            "board.json",
            match.slots["board_id"],
            size=entry.extra.get("json_size"),
            modified=entry.modified,
        ),
        _dir("members"),
        _dir("labels"),
        _dir("lists"),
    ]


async def _list_members(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    members = await list_board_members(accessor, match.slots["board_id"])
    return [
        MEMBER(
            member_filename(member),
            member["id"],
            size=len(to_json_bytes(normalize_member(member))),
        )
        for member in members
    ]


async def _list_labels(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    labels = await list_board_labels(accessor, match.slots["board_id"])
    return [
        LABEL(
            label_filename(label),
            label["id"],
            size=len(to_json_bytes(normalize_label(label))),
        )
        for label in labels
    ]


async def _list_lists(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    lists = await list_board_lists(accessor, match.slots["board_id"])
    # list.json's normalizer only uses fields the list listing already
    # carries, so its exact size is free here.
    return [
        LIST(
            list_dirname(lst),
            lst["id"],
            extra={"json_size": len(to_json_bytes(normalize_list(lst)))},
        )
        for lst in lists
    ]


async def _list_list(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    return [
        LIST_JSON(
            "list.json",
            match.slots["list_id"],
            size=entry.extra.get("json_size"),
        ),
        _dir("cards"),
    ]


async def _list_cards(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    cards = await list_list_cards(accessor, match.slots["list_id"])
    rows = []
    for card in cards:
        # card.json's normalizer only uses fields the card listing already
        # carries, so its exact size is free here.
        extra: dict[str, Any] = {
            "json_size": len(to_json_bytes(normalize_card(card)))
        }
        if accessor.capped():
            extra["unsearched"] = unsearched_text(card)
        rows.append(
            CARD(
                card_dirname(card),
                card["id"],
                modified=card.get("dateLastActivity"),
                extra=extra,
            )
        )
    return rows


async def _list_card(
    accessor: TrelloAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    # comments.jsonl needs a per-card actions call and stays size-unknown.
    card_id = match.slots["card_id"]
    return [
        CARD_JSON(
            "card.json",
            card_id,
            size=entry.extra.get("json_size"),
            modified=entry.modified,
        ),
        COMMENTS("comments.jsonl", card_id, modified=entry.modified),
    ]


readdir = make_readdir(
    detect_scope,
    listers={
        "workspaces": _list_workspaces_dir,
    },
    entry_listers={
        "workspace": _list_workspace,
        "boards": _list_boards,
        "board": _list_board,
        "members": _list_members,
        "labels": _list_labels,
        "lists": _list_lists,
        "list": _list_list,
        "cards": _list_cards,
        "card": _list_card,
    },
    static_root=("workspaces",),
)
