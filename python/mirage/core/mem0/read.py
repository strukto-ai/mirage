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
from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mem0._client import get_memory
from mirage.core.mem0.scope import ScopeLevel, detect
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _json_bytes(data: dict[str, Any]) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode()


async def _resolve_memory(
    accessor: Mem0Accessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> dict[str, Any]:
    scope = detect(path)
    if scope.level != ScopeLevel.MEMORY or scope.memory_id is None:
        raise enoent(path)
    lookup = await index.get(path.virtual)
    cached = (lookup.entry.extra.get("memory")
              if lookup.entry is not None else None)
    if isinstance(cached, dict):
        return cached
    return await get_memory(accessor.client, scope.memory_id, path)


async def read(
    accessor: Mem0Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    """Read a memory as full JSON bytes.

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        path (PathSpec): the memory file path.
        index (IndexCacheStore): index cache.
    """
    memory = await _resolve_memory(accessor, path, index)
    return _json_bytes(memory)


async def read_stream(
    accessor: Mem0Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    """Stream a memory as full JSON bytes (used by jq).

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        path (PathSpec): the memory file path.
        index (IndexCacheStore): index cache.
    """
    memory = await _resolve_memory(accessor, path, index)
    yield _json_bytes(memory)
