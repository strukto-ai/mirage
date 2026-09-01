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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.path import norm
from mirage.utils.ranges import slice_window


async def read_bytes(accessor: RAMAccessor,
                     path_spec: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read a file, optionally only a byte range of it.

    The bytes are already in memory, so the window is a slice rather
    than a smaller fetch. It is taken here anyway so a RAM mount answers
    a windowed read the same way every other backend does.

    Args:
        accessor (RAMAccessor): RAM accessor.
        path_spec (PathSpec): the path to read.
        index (IndexCacheStore): unused; the store is the listing.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path_spec.virtual
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    key = norm(path)
    if key not in store.files:
        raise enoent(virtual)
    data = store.files[key]
    if offset or size is not None:
        data = slice_window(data, offset, size)
    record("read", path, "ram", len(data), timer)
    return data


async def read(accessor: RAMAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX,
               offset: int = 0,
               size: int | None = None) -> bytes:
    try:
        return await read_bytes(accessor, path, index, offset, size)
    except FileNotFoundError as exc:
        raise enoent(path.virtual) from exc
