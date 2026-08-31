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
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.trello.client import (list_board_labels, list_board_lists,
                                       list_board_members, list_list_cards,
                                       list_workspace_boards, list_workspaces)
from mirage.core.trello.normalize import (normalize_board, normalize_card,
                                          normalize_label, normalize_list,
                                          normalize_member,
                                          normalize_workspace, to_json_bytes)
from mirage.core.trello.pathing import (board_dirname, card_dirname,
                                        label_filename, list_dirname,
                                        member_filename, workspace_dirname)
from mirage.core.trello.scope import detect_scope


async def _list_workspaces_dir(
        accessor: TrelloAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    workspaces = await list_workspaces(accessor.config, session=accessor.pool)
    if accessor.config.workspace_id:
        workspaces = [
            w for w in workspaces
            if w.get("id") == accessor.config.workspace_id
        ]
    entries = []
    for workspace in workspaces:
        dirname = workspace_dirname(workspace)
        # workspace.json renders the workspace object this listing already
        # fetched, so its exact size rides the directory entry for the
        # child listing to read back without another call.
        entries.append(
            (dirname,
             IndexEntry(
                 id=workspace["id"],
                 name=workspace.get("displayName") or workspace.get("name")
                 or workspace["id"],
                 resource_type="trello/workspace",
                 remote_time="",
                 vfs_name=dirname,
                 extra={
                     "json_size":
                     len(to_json_bytes(normalize_workspace(workspace))),
                 },
             )))
    return entries


async def _list_workspace(accessor: TrelloAccessor, match: ScopeMatch,
                          entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    return [
        ("workspace.json",
         IndexEntry(
             id=entry.id,
             name="workspace.json",
             resource_type="trello/workspace_json",
             vfs_name="workspace.json",
             size=entry.extra.get("json_size"),
         )),
        ("boards",
         IndexEntry(
             id=entry.id,
             name="boards",
             resource_type="trello/boards_dir",
             vfs_name="boards",
         )),
    ]


async def _list_boards(accessor: TrelloAccessor, match: ScopeMatch,
                       entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    boards = await list_workspace_boards(accessor.config,
                                         match.slots["workspace_id"],
                                         session=accessor.pool)
    if accessor.config.board_ids:
        boards = [
            b for b in boards if b.get("id") in accessor.config.board_ids
        ]
    entries = []
    for board in boards:
        dirname = board_dirname(board)
        # board.json's normalizer only uses fields the board listing
        # already carries, so its exact size is free here.
        entries.append((dirname,
                        IndexEntry(
                            id=board["id"],
                            name=board.get("name") or board["id"],
                            resource_type="trello/board",
                            remote_time=board.get("dateLastActivity") or "",
                            vfs_name=dirname,
                            extra={
                                "json_size":
                                len(to_json_bytes(normalize_board(board))),
                            },
                        )))
    return entries


async def _list_board(accessor: TrelloAccessor, match: ScopeMatch,
                      entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    return [
        ("board.json",
         IndexEntry(
             id=entry.id,
             name="board.json",
             resource_type="trello/board_json",
             vfs_name="board.json",
             size=entry.extra.get("json_size"),
             remote_time=entry.remote_time,
         )),
        ("members",
         IndexEntry(id=entry.id,
                    name="members",
                    resource_type="trello/members_dir",
                    vfs_name="members")),
        ("labels",
         IndexEntry(id=entry.id,
                    name="labels",
                    resource_type="trello/labels_dir",
                    vfs_name="labels")),
        ("lists",
         IndexEntry(id=entry.id,
                    name="lists",
                    resource_type="trello/lists_dir",
                    vfs_name="lists")),
    ]


async def _list_members(accessor: TrelloAccessor, match: ScopeMatch,
                        entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    members = await list_board_members(accessor.config,
                                       match.slots["board_id"],
                                       session=accessor.pool)
    entries = []
    for member in members:
        filename = member_filename(member)
        entries.append((filename,
                        IndexEntry(
                            id=member["id"],
                            name=member.get("fullName")
                            or member.get("username") or member["id"],
                            resource_type="trello/member",
                            remote_time="",
                            vfs_name=filename,
                            size=len(to_json_bytes(normalize_member(member))),
                        )))
    return entries


async def _list_labels(accessor: TrelloAccessor, match: ScopeMatch,
                       entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    labels = await list_board_labels(accessor.config,
                                     match.slots["board_id"],
                                     session=accessor.pool)
    entries = []
    for label in labels:
        filename = label_filename(label)
        entries.append((filename,
                        IndexEntry(
                            id=label["id"],
                            name=label.get("name") or label.get("color")
                            or label["id"],
                            resource_type="trello/label",
                            remote_time="",
                            vfs_name=filename,
                            size=len(to_json_bytes(normalize_label(label))),
                        )))
    return entries


async def _list_lists(accessor: TrelloAccessor, match: ScopeMatch,
                      entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    lists = await list_board_lists(accessor.config,
                                   match.slots["board_id"],
                                   session=accessor.pool)
    entries = []
    for lst in lists:
        dirname = list_dirname(lst)
        # list.json's normalizer only uses fields the list listing already
        # carries, so its exact size is free here.
        entries.append((dirname,
                        IndexEntry(
                            id=lst["id"],
                            name=lst.get("name") or lst["id"],
                            resource_type="trello/list",
                            remote_time="",
                            vfs_name=dirname,
                            extra={
                                "json_size":
                                len(to_json_bytes(normalize_list(lst))),
                            },
                        )))
    return entries


async def _list_list(accessor: TrelloAccessor, match: ScopeMatch,
                     entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    return [
        ("list.json",
         IndexEntry(
             id=entry.id,
             name="list.json",
             resource_type="trello/list_json",
             vfs_name="list.json",
             size=entry.extra.get("json_size"),
         )),
        ("cards",
         IndexEntry(id=entry.id,
                    name="cards",
                    resource_type="trello/cards_dir",
                    vfs_name="cards")),
    ]


async def _list_cards(accessor: TrelloAccessor, match: ScopeMatch,
                      entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    cards = await list_list_cards(accessor.config,
                                  match.slots["list_id"],
                                  session=accessor.pool)
    entries = []
    for card in cards:
        dirname = card_dirname(card)
        # card.json's normalizer only uses fields the card listing already
        # carries, so its exact size is free here.
        entries.append((dirname,
                        IndexEntry(
                            id=card["id"],
                            name=card.get("name") or card["id"],
                            resource_type="trello/card",
                            remote_time=card.get("dateLastActivity") or "",
                            vfs_name=dirname,
                            extra={
                                "json_size":
                                len(to_json_bytes(normalize_card(card))),
                            },
                        )))
    return entries


async def _list_card(accessor: TrelloAccessor, match: ScopeMatch,
                     entry: IndexEntry) -> list[tuple[str, IndexEntry]]:
    # comments.jsonl needs a per-card actions call and stays size-unknown.
    return [
        ("card.json",
         IndexEntry(
             id=entry.id,
             name="card.json",
             resource_type="trello/card_json",
             vfs_name="card.json",
             size=entry.extra.get("json_size"),
             remote_time=entry.remote_time,
         )),
        ("comments.jsonl",
         IndexEntry(
             id=entry.id,
             name="comments.jsonl",
             resource_type="trello/comments_jsonl",
             vfs_name="comments.jsonl",
             remote_time=entry.remote_time,
         )),
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
    static_root=("workspaces", ),
)
