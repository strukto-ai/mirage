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
from pathlib import Path

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.observe.context import record_stream
from mirage.types import PathSpec


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def read_stream(accessor: DiskAccessor,
                      path: PathSpec,
                      index: IndexCacheStore = None,
                      chunk_size: int = 8192) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path
    root = accessor.root
    rec = record_stream("read", path, "disk")
    p = _resolve(root, path)
    try:
        async with aiofiles.open(p, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                if rec is not None:
                    rec.bytes += len(chunk)
                yield chunk
    except FileNotFoundError as exc:
        raise FileNotFoundError(virtual) from exc
