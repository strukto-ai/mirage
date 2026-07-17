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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import invalidate_after_write
from mirage.types import PathSpec


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def copy(accessor: DiskAccessor, src_spec: PathSpec,
               dst_spec: PathSpec) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    root = accessor.root
    s = _resolve(root, src)
    d = _resolve(root, dst)
    await aiofiles.os.makedirs(d.parent, exist_ok=True)
    await asyncio.to_thread(shutil.copy2, s, d)
    await invalidate_after_write(dst_spec)
