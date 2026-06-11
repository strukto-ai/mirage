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
from mirage.cache.context import invalidate_after_write
from mirage.core.disk.utils import resolve_safe
from mirage.types import PathSpec


async def truncate(accessor: DiskAccessor, path: PathSpec,
                   length: int) -> None:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    p = resolve_safe(accessor.root, path)
    try:
        async with aiofiles.open(p, "rb") as f:
            data = await f.read()
    except FileNotFoundError:
        data = b""
    result = data[:length].ljust(length, b"\0")
    async with aiofiles.open(p, "wb") as f:
        await f.write(result)
    await invalidate_after_write(path)
