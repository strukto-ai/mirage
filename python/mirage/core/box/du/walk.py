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
from mirage.cache.index import IndexCacheStore
from mirage.core.box.readdir import readdir
from mirage.core.box.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def walk(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
    results: list[tuple[str, int]] | None,
) -> int:
    """Sum file sizes under a path, optionally collecting each one.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): directory or file to walk.
        index (IndexCacheStore): path->id index cache.
        results (list[tuple[str, int]] | None): when given, collects
            mount-relative (path, size) pairs for each file found.
    """
    try:
        info = await stat(accessor, path, index)
    except FileNotFoundError:
        return 0
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    if info.type != FileType.DIRECTORY:
        size = info.size or 0
        if results is not None:
            results.append(("/" + mount_key(path.virtual, prefix), size))
        return size
    try:
        children = await readdir(accessor, path, index)
    except FileNotFoundError:
        return 0
    total = 0
    for child in children:
        trimmed = child.rstrip("/")
        child_spec = PathSpec(virtual=trimmed,
                              directory=trimmed,
                              resolved=False,
                              resource_path=mount_key(trimmed, prefix))
        total += await walk(accessor, child_spec, index, results)
    return total
