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

import posixpath
from collections.abc import AsyncIterator
from functools import partial

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.warm import entry_or_warm
from mirage.core.box.api import download_file, download_file_stream
from mirage.core.box.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.ranges import window_for


async def _resolve_entry(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> IndexEntry:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.vfs_path
    if not key:
        raise IsADirectoryError(virtual)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    parent_key = posixpath.dirname(virtual_key) or "/"
    parent_path = PathSpec.from_str_path(parent_key,
                                         mount_key(parent_key, prefix))
    warm = (partial(readdir, accessor, parent_path, index)
            if parent_key != virtual_key else None)
    entry = await entry_or_warm(index, virtual_key, warm)
    if entry is None:
        raise enoent(virtual)
    if entry.resource_type == "box/folder":
        raise IsADirectoryError(virtual)
    return entry


async def read(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the file id.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    entry = await _resolve_entry(accessor, path, index)
    return await download_file(accessor.token_manager, entry.id,
                               window_for(offset, size))


async def stream(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    entry = await _resolve_entry(accessor, path, index)
    async for chunk in download_file_stream(accessor.token_manager, entry.id):
        yield chunk
