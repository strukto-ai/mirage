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
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.trello._client import (list_board_labels, list_board_lists,
                                        list_board_members, list_list_cards,
                                        list_workspace_boards, list_workspaces)
from mirage.core.trello.pathing import (board_dirname, card_dirname,
                                        label_filename, list_dirname,
                                        member_filename, workspace_dirname)
from mirage.types import PathSpec

VIRTUAL_ROOTS = ("workspaces", )


async def readdir(
    accessor: TrelloAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.directory if path.pattern else path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    idx_key = "/" + key if key else "/"

    if not key:
        return [f"{prefix}/workspaces"]

    if key == "workspaces":
        if index is not None:
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        workspaces = await list_workspaces(accessor.config)
        if accessor.config.workspace_id:
            workspaces = [
                w for w in workspaces
                if w.get("id") == accessor.config.workspace_id
            ]
        entries = []
        for ws in workspaces:
            dirname = workspace_dirname(ws)
            entry = IndexEntry(
                id=ws["id"],
                name=ws.get("displayName") or ws.get("name") or ws["id"],
                resource_type="trello/workspace",
                remote_time="",
                vfs_name=dirname,
            )
            entries.append((dirname, entry))
        if index is not None:
            await index.set_dir(idx_key, entries)
        return [f"{prefix}/workspaces/{name}" for name, _ in entries]

    parts = key.split("/")

    if len(parts) == 2 and parts[0] == "workspaces":
        if index is not None:
            result = await index.get(idx_key)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/workspaces",
                    directory=prefix + "/workspaces",
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(idx_key)
            if result.entry is None:
                raise FileNotFoundError(path)
        return [
            f"{prefix}/{key}/workspace.json",
            f"{prefix}/{key}/boards",
        ]

    if len(parts) == 3 and parts[0] == "workspaces" and parts[2] == "boards":
        ws_vkey = "/" + "/".join(parts[:2])
        if index is not None:
            result = await index.get(ws_vkey)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/workspaces",
                    directory=prefix + "/workspaces",
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(ws_vkey)
            if result.entry is None:
                raise FileNotFoundError(path)
            ws_id = result.entry.id
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        else:
            raise FileNotFoundError(path)
        boards = await list_workspace_boards(accessor.config, ws_id)
        if accessor.config.board_ids:
            boards = [
                b for b in boards if b.get("id") in accessor.config.board_ids
            ]
        entries = []
        for board in boards:
            dirname = board_dirname(board)
            entries.append((
                dirname,
                IndexEntry(
                    id=board["id"],
                    name=board.get("name") or board["id"],
                    resource_type="trello/board",
                    remote_time=board.get("dateLastActivity") or "",
                    vfs_name=dirname,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "boards":
        if index is not None:
            result = await index.get(idx_key)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:3]),
                    directory=prefix + "/" + "/".join(parts[:3]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(idx_key)
            if result.entry is None:
                raise FileNotFoundError(path)
        return [
            f"{prefix}/{key}/board.json",
            f"{prefix}/{key}/members",
            f"{prefix}/{key}/labels",
            f"{prefix}/{key}/lists",
        ]

    if (len(parts) == 5 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "members"):
        board_vkey = "/" + "/".join(parts[:4])
        if index is not None:
            result = await index.get(board_vkey)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:3]),
                    directory=prefix + "/" + "/".join(parts[:3]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(board_vkey)
            if result.entry is None:
                raise FileNotFoundError(path)
            board_id = result.entry.id
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        else:
            raise FileNotFoundError(path)
        members = await list_board_members(accessor.config, board_id)
        entries = []
        for member in members:
            filename = member_filename(member)
            entries.append((
                filename,
                IndexEntry(
                    id=member["id"],
                    name=member.get("fullName") or member.get("username")
                    or member["id"],
                    resource_type="trello/member",
                    remote_time="",
                    vfs_name=filename,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if (len(parts) == 5 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "labels"):
        board_vkey = "/" + "/".join(parts[:4])
        if index is not None:
            result = await index.get(board_vkey)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:3]),
                    directory=prefix + "/" + "/".join(parts[:3]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(board_vkey)
            if result.entry is None:
                raise FileNotFoundError(path)
            board_id = result.entry.id
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        else:
            raise FileNotFoundError(path)
        labels = await list_board_labels(accessor.config, board_id)
        entries = []
        for label in labels:
            filename = label_filename(label)
            entries.append((
                filename,
                IndexEntry(
                    id=label["id"],
                    name=label.get("name") or label.get("color")
                    or label["id"],
                    resource_type="trello/label",
                    remote_time="",
                    vfs_name=filename,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if (len(parts) == 5 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists"):
        board_vkey = "/" + "/".join(parts[:4])
        if index is not None:
            result = await index.get(board_vkey)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:3]),
                    directory=prefix + "/" + "/".join(parts[:3]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(board_vkey)
            if result.entry is None:
                raise FileNotFoundError(path)
            board_id = result.entry.id
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        else:
            raise FileNotFoundError(path)
        lists = await list_board_lists(accessor.config, board_id)
        entries = []
        for lst in lists:
            dirname = list_dirname(lst)
            entries.append((
                dirname,
                IndexEntry(
                    id=lst["id"],
                    name=lst.get("name") or lst["id"],
                    resource_type="trello/list",
                    remote_time="",
                    vfs_name=dirname,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if (len(parts) == 6 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists"):
        if index is not None:
            result = await index.get(idx_key)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:5]),
                    directory=prefix + "/" + "/".join(parts[:5]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(idx_key)
            if result.entry is None:
                raise FileNotFoundError(path)
        return [
            f"{prefix}/{key}/list.json",
            f"{prefix}/{key}/cards",
        ]

    if (len(parts) == 7 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "cards"):
        list_vkey = "/" + "/".join(parts[:6])
        if index is not None:
            result = await index.get(list_vkey)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:5]),
                    directory=prefix + "/" + "/".join(parts[:5]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(list_vkey)
            if result.entry is None:
                raise FileNotFoundError(path)
            list_id = result.entry.id
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        else:
            raise FileNotFoundError(path)
        cards = await list_list_cards(accessor.config, list_id)
        entries = []
        for card in cards:
            dirname = card_dirname(card)
            entries.append((
                dirname,
                IndexEntry(
                    id=card["id"],
                    name=card.get("name") or card["id"],
                    resource_type="trello/card",
                    remote_time=card.get("dateLastActivity") or "",
                    vfs_name=dirname,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if (len(parts) == 8 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "cards"):
        if index is not None:
            result = await index.get(idx_key)
            if result.entry is None:
                parent = PathSpec(
                    original=prefix + "/" + "/".join(parts[:7]),
                    directory=prefix + "/" + "/".join(parts[:7]),
                    prefix=prefix,
                )
                await readdir(accessor, parent, index)
                result = await index.get(idx_key)
            if result.entry is None:
                raise FileNotFoundError(path)
        return [f"{prefix}/{key}/card.json", f"{prefix}/{key}/comments.jsonl"]

    return []
