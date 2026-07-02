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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import norm


async def readdir(accessor: RAMAccessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    target = path.dir if path.pattern else path
    prefix = mount_prefix_of(target.virtual, target.resource_path)
    virtual_key = target.virtual
    store = accessor.store
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    p = norm(target.resource_path)
    if p not in store.dirs:
        raise FileNotFoundError(p)
    dir_prefix = p.rstrip("/") + "/"
    seen: set[str] = set()
    for key in list(store.files) + list(store.dirs):
        if key == p:
            continue
        if key.startswith(dir_prefix):
            remainder = key[len(dir_prefix):]
            child = remainder.split("/")[0]
            if child:
                seen.add(dir_prefix + child)
    entries = sorted(seen)
    virtual_entries = sorted((prefix + e if prefix else e) for e in entries)
    index_entries = [(e.rsplit("/", 1)[-1],
                      IndexEntry(id=e,
                                 name=e.rsplit("/", 1)[-1],
                                 resource_type="file")) for e in entries]
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
