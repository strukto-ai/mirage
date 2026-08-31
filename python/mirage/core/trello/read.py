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
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import jsonl_bytes_by_created_at
from mirage.core.trello.client import (get_board, get_card, list_board_labels,
                                       list_board_lists, list_board_members,
                                       list_card_comments, list_workspaces)
from mirage.core.trello.normalize import (normalize_board, normalize_card,
                                          normalize_comment, normalize_label,
                                          normalize_list, normalize_member,
                                          normalize_workspace, to_json_bytes)
from mirage.core.trello.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _read_workspace_json(accessor: TrelloAccessor, match: ScopeMatch,
                               path: PathSpec,
                               index: IndexCacheStore) -> bytes:
    workspace_id = match.slots["workspace_id"]
    for workspace in await list_workspaces(accessor.config,
                                           session=accessor.pool):
        if workspace.get("id") == workspace_id:
            return to_json_bytes(normalize_workspace(workspace))
    raise enoent(path.virtual)


async def _read_board_json(accessor: TrelloAccessor, match: ScopeMatch,
                           path: PathSpec, index: IndexCacheStore) -> bytes:
    board = await get_board(accessor.config,
                            match.slots["board_id"],
                            session=accessor.pool)
    return to_json_bytes(normalize_board(board))


async def _read_member(accessor: TrelloAccessor, match: ScopeMatch,
                       path: PathSpec, index: IndexCacheStore) -> bytes:
    member_id = match.slots["member_id"]
    members = await list_board_members(accessor.config,
                                       match.slots["board_id"],
                                       session=accessor.pool)
    for member in members:
        if member.get("id") == member_id:
            return to_json_bytes(normalize_member(member))
    raise enoent(path.virtual)


async def _read_label(accessor: TrelloAccessor, match: ScopeMatch,
                      path: PathSpec, index: IndexCacheStore) -> bytes:
    label_id = match.slots["label_id"]
    labels = await list_board_labels(accessor.config,
                                     match.slots["board_id"],
                                     session=accessor.pool)
    for label in labels:
        if label.get("id") == label_id:
            return to_json_bytes(normalize_label(label))
    raise enoent(path.virtual)


async def _read_list_json(accessor: TrelloAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> bytes:
    list_id = match.slots["list_id"]
    lists = await list_board_lists(accessor.config,
                                   match.slots["board_id"],
                                   session=accessor.pool)
    for lst in lists:
        if lst.get("id") == list_id:
            return to_json_bytes(normalize_list(lst))
    raise enoent(path.virtual)


async def _read_card_json(accessor: TrelloAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> bytes:
    card = await get_card(accessor.config,
                          match.slots["card_id"],
                          session=accessor.pool)
    return to_json_bytes(normalize_card(card))


async def _read_comments(accessor: TrelloAccessor, match: ScopeMatch,
                         path: PathSpec, index: IndexCacheStore) -> bytes:
    card_id = match.slots["card_id"]
    comments = await list_card_comments(accessor.config,
                                        card_id,
                                        session=accessor.pool)
    rows = [
        normalize_comment(comment, card_id=card_id) for comment in comments
    ]
    return jsonl_bytes_by_created_at(rows)


read = make_read(
    detect_scope,
    readers={
        "workspace_json": _read_workspace_json,
        "board_json": _read_board_json,
        "member": _read_member,
        "label": _read_label,
        "list_json": _read_list_json,
        "card_json": _read_card_json,
        "comments_jsonl": _read_comments,
    },
)
