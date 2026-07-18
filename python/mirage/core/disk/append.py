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

import time
from pathlib import Path

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import invalidate_after_write
from mirage.observe.context import record
from mirage.types import PathSpec


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def append_bytes(accessor: DiskAccessor, path_spec: PathSpec,
                       data: bytes) -> None:
    path = path_spec.mount_path
    root = accessor.root
    start_ms = int(time.monotonic() * 1000)
    p = _resolve(root, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(p, "ab") as f:
        await f.write(data)
    record("append", path, "disk", len(data), start_ms)
    await invalidate_after_write(path_spec)
