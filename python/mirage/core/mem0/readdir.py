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

from mirage.accessor.mem0 import Mem0Accessor
from mirage.core.hierarchy.readdir import cut_listing, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mem0.client import get_all_memories
from mirage.core.mem0.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.errors.fs import enoent
from mirage.types import ContentType, DirListing, FileStat, FileType, PathSpec


def memory_row(memory: dict[str, Any]) -> FileStat:
    """A memory's file as its listing names it, carrying the memory.

    The listing carries every payload, so the row holds the memory a
    read renders and the read costs no call of its own.

    Args:
        memory (dict[str, Any]): the memory as the API returns it.
    """
    return FileStat(
        name=f"{memory['id']}.json",
        type=FileType.FILE,
        content=ContentType.JSON,
        size=len(json_bytes(memory)),
        modified=memory.get("updated_at") or memory.get("created_at"),
        extra={
            "created_at": memory.get("created_at"),
            "updated_at": memory.get("updated_at"),
            "memory": memory,
        },
    )


async def _list_memories(
    accessor: Mem0Accessor, match: ScopeMatch
) -> list[FileStat] | DirListing:
    memories = await get_all_memories(
        accessor.client,
        filters=accessor.config.scope_filter,
        page_size=accessor.config.default_page_size,
        limit=match.limit,
    )
    return cut_listing([memory_row(m) for m in memories], match.limit)


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_memories},
    leaf_error="enotdir",
)


def listed_memory(path: PathSpec, entry: FileStat | None) -> dict[str, Any]:
    """The memory a path names, as the scoped listing holds it.

    Which memories exist is a function of the configured entity filter,
    and the listing is the one place that filter is applied: fetching by
    the id in the file name served a memory of any user, agent or run
    the API key reaches, while ``ls`` hid it. The mount hands the row
    the listing holds, which carries the memory.

    Args:
        path (PathSpec): the memory file path.
        entry (FileStat | None): the row the listing holds there.

    Raises:
        FileNotFoundError: the path names no memory the scope holds.
    """
    if detect_scope(path).kind != "memory" or entry is None:
        raise enoent(path.virtual)
    memory = entry.extra.get("memory")
    if not isinstance(memory, dict):
        raise enoent(path.virtual)
    return memory
