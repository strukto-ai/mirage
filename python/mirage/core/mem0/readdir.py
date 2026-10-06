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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mem0.client import get_all_memories
from mirage.core.mem0.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def _list_memories(
    accessor: Mem0Accessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    memories = await get_all_memories(
        accessor.client,
        filters=accessor.config.scope_filter,
        page_size=accessor.config.default_page_size,
    )
    entries: list[tuple[str, IndexEntry]] = []
    for m in memories:
        body = json_bytes(m)
        memory_id = str(m["id"])
        filename = f"{memory_id}.json"
        entry = IndexEntry(
            id=memory_id,
            name=filename,
            resource_type="mem0/memory",
            vfs_name=filename,
            size=len(body),
            remote_time=m.get("updated_at") or m.get("created_at") or "",
            extra={"memory": m},
        )
        entries.append((filename, entry))
    return entries


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_memories},
    leaf_error="enotdir",
)


async def listed_memory(
    accessor: Mem0Accessor, path: PathSpec, index: IndexCacheStore
) -> dict[str, Any]:
    """The memory a path names, as the scoped listing holds it.

    Which memories exist is a function of the configured entity filter,
    and the listing is the one place that filter is applied: fetching by
    the id in the file name served a memory of any user, agent or run
    the API key reaches, while ``ls`` hid it. The listing carries every
    payload, so a warm index answers with no call and a cold one costs
    the listing it would have cost ``ls``.

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        path (PathSpec): the memory file path.
        index (IndexCacheStore): index cache.

    Raises:
        FileNotFoundError: the path names no memory the scope holds.
    """
    if detect_scope(path).kind != "memory":
        raise enoent(path.virtual)
    if index is NULL_INDEX or index is None:
        # resolve_entry reads back what its warm just listed, so a caller
        # with no cache still needs one for the duration of the call.
        index = RAMIndexCacheStore()
    entry = await resolve_entry(readdir, accessor, path, index)
    memory = entry.extra.get("memory") if entry is not None else None
    if not isinstance(memory, dict):
        raise enoent(path.virtual)
    return memory
