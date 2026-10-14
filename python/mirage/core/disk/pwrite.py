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

import os
from functools import partial

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import open_flags, resolve_inside
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def pwrite(
    accessor: DiskAccessor, path_spec: PathSpec, data: bytes, offset: int
) -> None:
    timer = start_op()
    p = await resolve_inside(accessor.root, path_spec)
    opener = partial(open_flags, os.O_WRONLY | os.O_CREAT)
    with disk_errors(path_spec.virtual):
        async with aiofiles.open(p, "wb", opener=opener) as f:
            await f.seek(offset)
            await f.write(data)
    record("pwrite", path_spec.virtual, "disk", len(data), timer)
