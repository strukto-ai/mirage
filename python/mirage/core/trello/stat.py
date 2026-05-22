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
from mirage.core.trello.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec

VIRTUAL_DIRS = {"", "workspaces"}


async def _lookup_with_fallback(
    accessor: TrelloAccessor,
    idx_key: str,
    prefix: str,
    index: IndexCacheStore,
):
    result = await index.get(idx_key)
    if result.entry is not None:
        return result
    parent_idx = idx_key.rsplit("/", 1)[0] or "/"
    parent_path = (prefix + parent_idx) if prefix else parent_idx
    try:
        await _readdir(
            accessor,
            PathSpec(original=parent_path,
                     directory=parent_path,
                     prefix=prefix),
            index=index,
        )
    # best-effort cache populate; canonical ENOENT raised below
    except Exception:
        pass
    return await index.get(idx_key)


async def stat(
    accessor: TrelloAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    idx_key = "/" + key if key else "/"

    if key in VIRTUAL_DIRS:
        return FileStat(name=key if key else "/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if len(parts) == 2 and parts[0] == "workspaces":
        if index is None:
            raise FileNotFoundError(path)
        result = await _lookup_with_fallback(accessor, idx_key, prefix, index)
        if result.entry is None:
            raise FileNotFoundError(path)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            extra={"workspace_id": result.entry.id},
        )

    if len(parts) == 3 and parts[0] == "workspaces":
        if parts[2] == "workspace.json":
            ws_key = "/" + "/".join(parts[:2])
            if index is not None:
                result = await index.get(ws_key)
                ws_id = result.entry.id if result.entry else None
            else:
                ws_id = None
            return FileStat(
                name="workspace.json",
                type=FileType.JSON,
                extra={"workspace_id": ws_id},
            )
        if parts[2] == "boards":
            return FileStat(name="boards", type=FileType.DIRECTORY)

    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "boards":
        if index is None:
            raise FileNotFoundError(path)
        result = await _lookup_with_fallback(accessor, idx_key, prefix, index)
        if result.entry is None:
            raise FileNotFoundError(path)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            extra={"board_id": result.entry.id},
        )

    if (len(parts) == 5 and parts[0] == "workspaces" and parts[2] == "boards"):
        if parts[4] == "board.json":
            board_key = "/" + "/".join(parts[:4])
            if index is not None:
                result = await index.get(board_key)
                board_id = result.entry.id if result.entry else None
            else:
                board_id = None
            return FileStat(
                name="board.json",
                type=FileType.JSON,
                extra={"board_id": board_id},
            )
        if parts[4] in {"members", "labels", "lists"}:
            return FileStat(name=parts[4], type=FileType.DIRECTORY)

    if (len(parts) == 6 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "members"):
        if index is None:
            raise FileNotFoundError(path)
        result = await _lookup_with_fallback(accessor, idx_key, prefix, index)
        if result.entry is None:
            raise FileNotFoundError(path)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            extra={"member_id": result.entry.id},
        )

    if (len(parts) == 6 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "labels"):
        if index is None:
            raise FileNotFoundError(path)
        result = await _lookup_with_fallback(accessor, idx_key, prefix, index)
        if result.entry is None:
            raise FileNotFoundError(path)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            extra={"label_id": result.entry.id},
        )

    if (len(parts) == 6 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists"):
        if index is None:
            raise FileNotFoundError(path)
        result = await _lookup_with_fallback(accessor, idx_key, prefix, index)
        if result.entry is None:
            raise FileNotFoundError(path)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            extra={"list_id": result.entry.id},
        )

    if (len(parts) == 7 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists"):
        if parts[6] == "list.json":
            list_key = "/" + "/".join(parts[:6])
            if index is not None:
                result = await index.get(list_key)
                list_id = result.entry.id if result.entry else None
            else:
                list_id = None
            return FileStat(
                name="list.json",
                type=FileType.JSON,
                extra={"list_id": list_id},
            )
        if parts[6] == "cards":
            return FileStat(name="cards", type=FileType.DIRECTORY)

    if (len(parts) == 8 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "cards"):
        if index is None:
            raise FileNotFoundError(path)
        result = await _lookup_with_fallback(accessor, idx_key, prefix, index)
        if result.entry is None:
            raise FileNotFoundError(path)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            extra={"card_id": result.entry.id},
        )

    if (len(parts) == 9 and parts[0] == "workspaces" and parts[2] == "boards"
            and parts[4] == "lists" and parts[6] == "cards"):
        if parts[8] == "card.json":
            card_key = "/" + "/".join(parts[:8])
            if index is not None:
                result = await index.get(card_key)
                card_id = result.entry.id if result.entry else None
            else:
                card_id = None
            return FileStat(
                name="card.json",
                type=FileType.JSON,
                extra={"card_id": card_id},
            )
        if parts[8] == "comments.jsonl":
            card_key = "/" + "/".join(parts[:8])
            if index is not None:
                result = await index.get(card_key)
                card_id = result.entry.id if result.entry else None
            else:
                card_id = None
            return FileStat(
                name="comments.jsonl",
                type=FileType.TEXT,
                extra={"card_id": card_id},
            )

    raise FileNotFoundError(path)
