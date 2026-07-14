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
from pathlib import Path

import aiofiles.os
from aiofiles.os import path as aio_path

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.types import PathSpec
from mirage.utils.path import norm


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def rm_r(accessor: DiskAccessor, path: PathSpec) -> None:
    if isinstance(path, PathSpec):
        path = path.mount_path
    p = _resolve(accessor.root, path)
    if await aio_path.isdir(p):
        await asyncio.to_thread(shutil.rmtree, p)
    elif await aio_path.exists(p):
        await aiofiles.os.remove(p)
    key = norm(path)
    prefix = key.rstrip("/") + "/"
    for stale in list(accessor.attrs):
        if stale == key or stale.startswith(prefix):
            del accessor.attrs[stale]
    await invalidate_after_unlink(path)
