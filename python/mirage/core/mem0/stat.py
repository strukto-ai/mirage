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
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.mem0.client import get_memory
from mirage.core.mem0.readdir import readdir
from mirage.core.mem0.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _file_stat(memory: dict[str, Any]) -> FileStat:
    body = json_bytes(memory)
    return FileStat(
        name=f"{memory['id']}.json",
        type=FileType.FILE,
        content=ContentType.JSON,
        size=len(body),
        modified=memory.get("updated_at") or memory.get("created_at"),
        id=memory["id"],
        extra={
            "created_at": memory.get("created_at"),
            "updated_at": memory.get("updated_at"),
        },
    )


async def _memory_stat(accessor: Mem0Accessor, match: ScopeMatch,
                       path: PathSpec, index: IndexCacheStore) -> FileStat:
    # The root listing caches each memory's whole payload, so a warm
    # index answers without a network call.
    lookup = await index.get(path.virtual)
    cached = (lookup.entry.extra.get("memory")
              if lookup.entry is not None else None)
    if isinstance(cached, dict):
        return _file_stat(cached)
    memory = await get_memory(accessor.client, match.slots["memory_id"], path)
    return _file_stat(memory)


stat = make_stat(
    detect_scope,
    readdir,
    overrides={"memory": _memory_stat},
)
