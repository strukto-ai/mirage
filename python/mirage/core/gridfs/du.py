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

import re
from typing import Any

from mirage.accessor.gridfs import GridFSAccessor
from mirage.core.gridfs._client import _key, iter_latest
from mirage.types import PathSpec


def _du_query(stem: str) -> dict[str, Any]:
    if not stem:
        return {}
    return {
        "$or": [
            {
                "filename": stem
            },
            {
                "filename": {
                    "$regex": "^" + re.escape(stem + "/")
                }
            },
        ]
    }


async def du(accessor: GridFSAccessor, path_spec: PathSpec) -> int:
    """Total size in bytes under a prefix.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): Prefix path_spec.
    """
    path = path_spec.mount_path
    config = accessor.config
    key = _key(path, config)
    stem = key.rstrip("/")
    total = 0
    async for doc in iter_latest(accessor, _du_query(stem)):
        total += doc["length"]
    return total


async def du_all(accessor: GridFSAccessor,
                 path_spec: PathSpec) -> list[tuple[str, int]]:
    """List of (path_spec, size) tuples plus a total entry.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): Prefix path_spec.
    """
    path = path_spec.mount_path
    config = accessor.config
    key = _key(path, config)
    stem = key.rstrip("/")
    results: list[tuple[str, int]] = []
    total = 0
    async for doc in iter_latest(accessor, _du_query(stem)):
        sz = doc["length"]
        entry = "/" + doc["filename"].lstrip("/")
        results.append((entry, sz))
        total += sz
    results.append((path, total))
    return results
