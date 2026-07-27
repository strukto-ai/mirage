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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gridfs._client import _key, _strip_prefix, iter_latest
from mirage.core.gridfs.du.query import subtree_query
from mirage.types import PathSpec


async def entries(
        accessor: GridFSAccessor,
        path_spec: PathSpec,
        index: IndexCacheStore = NULL_INDEX
) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a prefix plus their total.

    Filenames are stripped back to mount-relative paths, so a collection
    mounted at a ``key_prefix`` reports the paths the user typed rather
    than the raw stored filenames.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): target path.
    """
    config = accessor.config
    stem = _key(path_spec.mount_path, config).rstrip("/")
    found: list[tuple[str, int]] = []
    total = 0
    async for doc in iter_latest(accessor, subtree_query(stem)):
        doc_size = doc["length"]
        rel = _strip_prefix(doc["filename"], config)
        found.append(("/" + rel.lstrip("/"), doc_size))
        total += doc_size
    found.sort()
    return found, total
