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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def read_bytes(accessor: DiskAccessor,
                     path_spec: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> bytes:
    virtual = path_spec.virtual
    path = path_spec.mount_path
    root = accessor.root
    start_ms = int(time.monotonic() * 1000)
    p = _resolve(root, path)
    try:
        async with aiofiles.open(p, "rb") as f:
            data = await f.read()
    except FileNotFoundError as exc:
        raise FileNotFoundError(virtual) from exc
    record("read", path, "disk", len(data), start_ms)
    return data


async def read_range(accessor: DiskAccessor,
                     path_spec: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read a byte range, seeking rather than reading the whole file.

    Args:
        accessor (DiskAccessor): the mount's disk handle.
        path_spec (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, unused here.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path_spec.virtual
    path = path_spec.mount_path
    root = accessor.root
    start_ms = int(time.monotonic() * 1000)
    p = _resolve(root, path)
    try:
        async with aiofiles.open(p, "rb") as f:
            await f.seek(offset)
            data = await (f.read() if size is None else f.read(size))
    except FileNotFoundError as exc:
        raise FileNotFoundError(virtual) from exc
    record("read", path, "disk", len(data), start_ms)
    return data
