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
from aiofiles.os import path as aio_path

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.timeutil import epoch_to_iso
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import guess_type


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def stat(accessor: DiskAccessor,
               path: PathSpec,
               index: IndexCacheStore = None) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path
    root = accessor.root
    p = _resolve(root, path)
    if not await aio_path.exists(p):
        raise FileNotFoundError(virtual)
    st = await aiofiles.os.stat(p)
    modified = epoch_to_iso(st.st_mtime)
    if await aio_path.isdir(p):
        return FileStat(name=p.name,
                        size=None,
                        modified=modified,
                        type=FileType.DIRECTORY)
    return FileStat(name=p.name,
                    size=st.st_size,
                    modified=modified,
                    fingerprint=modified,
                    type=guess_type(p.name))
