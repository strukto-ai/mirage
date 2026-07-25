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

import json
from typing import Any

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mem0._client import get_memory
from mirage.core.mem0.scope import ScopeLevel, detect
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


def _file_stat(memory: dict[str, Any]) -> FileStat:
    body = json.dumps(memory, ensure_ascii=False, indent=2).encode()
    return FileStat(
        name=f"{memory['id']}.json",
        type=FileType.JSON,
        size=len(body),
        modified=memory.get("updated_at") or memory.get("created_at"),
        extra={
            "created_at": memory.get("created_at"),
            "updated_at": memory.get("updated_at"),
        },
    )


async def stat(
    accessor: Mem0Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat a mem0 path.

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): index cache.
    """
    scope = detect(path)
    if scope.level == ScopeLevel.ROOT:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if scope.level != ScopeLevel.MEMORY or scope.memory_id is None:
        raise enoent(path)
    lookup = await index.get(path.virtual)
    cached = (lookup.entry.extra.get("memory")
              if lookup.entry is not None else None)
    if isinstance(cached, dict):
        return _file_stat(cached)
    memory = await get_memory(accessor.client, scope.memory_id, path)
    return _file_stat(memory)
