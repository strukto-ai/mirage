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
import shutil

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.disk.utils import resolve_safe
from mirage.types import PathSpec


async def copy(accessor: DiskAccessor, src: PathSpec, dst: PathSpec) -> None:
    if isinstance(src, str):
        src = PathSpec(original=src, directory=src)
    if isinstance(src, PathSpec):
        src = src.strip_prefix
    if isinstance(dst, str):
        dst = PathSpec(original=dst, directory=dst)
    if isinstance(dst, PathSpec):
        dst = dst.strip_prefix
    root = accessor.root
    s = resolve_safe(root, src)
    d = resolve_safe(root, dst)
    await aiofiles.os.makedirs(d.parent, exist_ok=True)
    await asyncio.to_thread(shutil.copy2, s, d)
    await invalidate_after_write(dst)
