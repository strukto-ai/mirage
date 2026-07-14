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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import norm


async def readdir(
    accessor: RedisAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> list[str]:
    virtual = path.virtual
    if isinstance(path, PathSpec):
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        path = path.directory if path.pattern else path.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    store = accessor.store
    # Canonical key: no trailing slash (except root), or the same dir
    # indexes under two keys and cache hits return doubled-slash entries.
    virtual_key = prefix + path if prefix else path
    virtual_key = virtual_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    p = norm(path)
    if not await store.has_dir(p):
        raise enoent(virtual)
    dir_prefix = p.rstrip("/") + "/"
    seen: set[str] = set()
    all_files = await store.list_files()
    all_dirs = await store.list_dirs()
    for key in all_files + list(all_dirs):
        if key == p:
            continue
        if key.startswith(dir_prefix):
            remainder = key[len(dir_prefix):]
            child = remainder.split("/")[0]
            if child:
                seen.add(dir_prefix + child)
    entries = sorted(seen)
    virtual_entries = sorted((prefix + e if prefix else e) for e in entries)
    index_entries = [(
        e.rsplit("/", 1)[-1],
        IndexEntry(
            id=e,
            name=e.rsplit("/", 1)[-1],
            resource_type="file",
        ),
    ) for e in entries]
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
