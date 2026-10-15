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

from collections.abc import AsyncIterator

from mirage.accessor.mem0 import Mem0Accessor
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mem0.readdir import listed_memory
from mirage.core.mem0.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.types import FileStat, PathSpec


async def _read_memory(
    accessor: Mem0Accessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    return json_bytes(listed_memory(path, entry))


read = make_read(detect_scope, {"memory": _read_memory})


async def read_stream(
    accessor: Mem0Accessor, path: PathSpec, entry: FileStat | None = None
) -> AsyncIterator[bytes]:
    """Stream a memory as full JSON bytes (used by jq).

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        path (PathSpec): the memory file path.
        entry (FileStat | None): the row the listing holds there.
    """
    yield json_bytes(listed_memory(path, entry))
