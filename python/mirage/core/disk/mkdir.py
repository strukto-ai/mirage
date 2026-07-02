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


async def mkdir(accessor: DiskAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    if isinstance(path, PathSpec):
        path = path.mount_path
    p = _resolve(accessor.root, path)
    if parents:
        await aiofiles.os.makedirs(p, exist_ok=True)
    else:
        try:
            await aiofiles.os.mkdir(p)
        except FileExistsError:
            pass
    await invalidate_after_write(path)
