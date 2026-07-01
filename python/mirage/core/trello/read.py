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
from mirage.cache.index import IndexCacheStore
from mirage.core.trello._client import (get_board, get_card, list_board_labels,
                                        list_board_lists, list_board_members,
                                        list_card_comments, list_workspaces)
from mirage.core.trello.normalize import (normalize_board, normalize_card,
                                          normalize_comment, normalize_label,
                                          normalize_list, normalize_member,
                                          normalize_workspace, to_json_bytes,
                                          to_jsonl_bytes)
from mirage.core.trello.pathing import split_suffix_id
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(
    config: TrelloConfig,
    path: PathSpec,
    virtual: str,
) -> bytes:
    key = path.strip("/")
    parts = key.split("/")

    if (len(parts) == 3 and parts[0] == "workspaces"
            and parts[2] == "workspace.json"):
        _, ws_id = split_suffix_id(parts[1])
        workspaces = await list_workspaces(config)
        for ws in workspaces:
            if ws.get("id") == ws_id:
                return to_json_bytes(normalize_workspace(ws))
        raise enoent(virtual)

    if (len(parts) == 5 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "board.json"):
        _, board_id = split_suffix_id(parts[3])
        board = await get_board(config, board_id)
        return to_json_bytes(normalize_board(board))

    if (len(parts) == 6 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "members"):
        _, board_id = split_suffix_id(parts[3])
        _, member_id = split_suffix_id(parts[5], suffix=".json")
        members = await list_board_members(config, board_id)
        for member in members:
            if member.get("id") == member_id:
                return to_json_bytes(normalize_member(member))
        raise enoent(virtual)

    if (len(parts) == 6 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "labels"):
        _, board_id = split_suffix_id(parts[3])
        _, label_id = split_suffix_id(parts[5], suffix=".json")
        labels = await list_board_labels(config, board_id)
        for label in labels:
            if label.get("id") == label_id:
                return to_json_bytes(normalize_label(label))
        raise enoent(virtual)

    if (len(parts) == 7 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "list.json"):
        _, board_id = split_suffix_id(parts[3])
        _, list_id = split_suffix_id(parts[5])
        lists = await list_board_lists(config, board_id)
        for lst in lists:
            if lst.get("id") == list_id:
                return to_json_bytes(normalize_list(lst))
        raise enoent(virtual)

    if (len(parts) == 9 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "cards"
            and parts[8] == "card.json"):
        _, card_id = split_suffix_id(parts[7])
        card = await get_card(config, card_id)
        return to_json_bytes(normalize_card(card))

    if (len(parts) == 9 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "cards"
            and parts[8] == "comments.jsonl"):
        _, card_id = split_suffix_id(parts[7])
        comments = await list_card_comments(config, card_id)
        rows = [
            normalize_comment(comment, card_id=card_id) for comment in comments
        ]
        return to_jsonl_bytes(rows)

    raise enoent(virtual)


async def read(
    accessor: TrelloAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original
    if isinstance(path, PathSpec):
        path = path.strip_prefix

    return await read_bytes(accessor.config, path, virtual)
