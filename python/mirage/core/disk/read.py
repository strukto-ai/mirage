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

import asyncio

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import resolve_inside_sync
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def read(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, or a byte range of it, seeking rather than reading
    the whole file.

    Args:
        accessor (DiskAccessor): the mount's disk handle.
        path_spec (PathSpec): the path to read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path_spec.virtual
    root = accessor.root
    timer = start_op()

    def take() -> bytes:
        p = resolve_inside_sync(root, path_spec)
        with disk_errors(virtual):
            with open(p, "rb") as f:
                f.seek(offset)
                return f.read() if size is None else f.read(size)

    data = await asyncio.to_thread(take)
    record("read", virtual, "disk", len(data), timer)
    return data
