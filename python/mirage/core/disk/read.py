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

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import resolve_inside
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def read(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    virtual = path_spec.virtual
    root = accessor.root
    timer = start_op()
    p = await resolve_inside(root, path_spec)
    with disk_errors(virtual):
        async with aiofiles.open(p, "rb") as f:
            data = await f.read()
    record("read", virtual, "disk", len(data), timer)
    return data


async def read_range(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a byte range, seeking rather than reading the whole file.

    Args:
        accessor (DiskAccessor): the mount's disk handle.
        path_spec (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, unused here.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path_spec.virtual
    root = accessor.root
    timer = start_op()
    p = await resolve_inside(root, path_spec)
    with disk_errors(virtual):
        async with aiofiles.open(p, "rb") as f:
            await f.seek(offset)
            data = await (f.read() if size is None else f.read(size))
    record("read", virtual, "disk", len(data), timer)
    return data
