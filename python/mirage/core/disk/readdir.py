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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


async def readdir(accessor: DiskAccessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    if isinstance(path, PathSpec):
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        path = path.directory if path.pattern else path.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    root = accessor.root
    # Canonical key: no trailing slash (except root), or the same dir
    # indexes under two keys and cache hits return doubled-slash entries.
    virtual_key = prefix + path if prefix else path
    virtual_key = virtual_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    p = _resolve(root, path)
    if not await aio_path.isdir(p):
        raise NotADirectoryError(str(p))
    base = "/" + path.strip("/")
    raw = await aiofiles.os.listdir(p)
    entries = sorted(base.rstrip("/") + "/" + name for name in raw)
    virtual_entries = sorted((prefix + e if prefix else e) for e in entries)
    index_entries = [(e.rsplit("/", 1)[-1],
                      IndexEntry(id=e,
                                 name=e.rsplit("/", 1)[-1],
                                 resource_type="file")) for e in entries]
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
