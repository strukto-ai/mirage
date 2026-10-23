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

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import resolve_inside
from mirage.observe.context import record_stream
from mirage.types import PathSpec


async def read_stream(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    chunk_size: int = 65536,
) -> AsyncIterator[bytes]:
    virtual = path_spec.virtual
    root = accessor.root
    rec = record_stream("read", virtual, "disk")
    p = await resolve_inside(root, path_spec)
    with disk_errors(virtual):
        async with aiofiles.open(p, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                if rec is not None:
                    rec.bytes += len(chunk)
                yield chunk
