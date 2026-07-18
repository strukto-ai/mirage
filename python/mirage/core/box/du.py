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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.box.readdir import readdir
from mirage.core.box.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def _walk_size(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
    entries: list[tuple[str, int]] | None,
) -> int:
    try:
        info = await stat(accessor, path, index)
    except FileNotFoundError:
        return 0
    if info.type != FileType.DIRECTORY:
        size = info.size or 0
        if entries is not None:
            prefix = mount_prefix_of(path.virtual, path.resource_path)
            raw = path.virtual.rstrip("/")
            key = raw[len(prefix
                          ):] if prefix and raw.startswith(prefix) else raw
            entries.append((key, size))
        return size
    try:
        children = await readdir(accessor, path, index)
    except FileNotFoundError:
        return 0
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    total = 0
    for child in children:
        trimmed = child.rstrip("/")
        child_spec = PathSpec(virtual=trimmed,
                              directory=trimmed,
                              resolved=False,
                              resource_path=mount_key(trimmed, prefix))
        total += await _walk_size(accessor, child_spec, index, entries)
    return total


async def du(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> int:
    return await _walk_size(accessor, path, index, None)


async def du_all(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[tuple[str, int]]:
    """List of (path, size) tuples plus a total entry (du_multi contract).

    For a file there is no tree to walk; return an empty list so the
    generic du falls back to ``du`` for the single-file total.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): target path.
        index (IndexCacheStore): path->id index cache.
    """
    try:
        info = await stat(accessor, path, index)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return []
    entries: list[tuple[str, int]] = []
    total = await _walk_size(accessor, path, index, entries)
    entries.sort()
    entries.append((path.mount_path, total))
    return entries
