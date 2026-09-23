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

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.core.ram.rm import rm_r
from mirage.types import PathSpec
from mirage.vfs.ram.store import RAMStore


def _spec(virtual: str) -> PathSpec:
    return PathSpec(vfs_path=virtual.strip("/"),
                    virtual=virtual,
                    directory="/",
                    pattern=None,
                    resolved=True)


async def _seeded(
) -> tuple[RAMAccessor, RAMFileCacheStore, RAMIndexCacheStore]:
    store = RAMStore()
    store.dirs.add("/a")
    store.dirs.add("/a/b")
    store.files["/a/b/f.txt"] = b"hi\n"
    cache = RAMFileCacheStore()
    index = RAMIndexCacheStore(ttl=600)
    await cache.set("/data/a/b/f.txt", b"hi\n")
    entry = IndexEntry(id="1", name="f.txt", resource_type="file")
    await index.set_dir("/data/a", [("b", entry)])
    await index.set_dir("/data/a/b", [("f.txt", entry)])
    return RAMAccessor(store), cache, index


async def _rm_r_case() -> tuple[bool, bool, bool]:
    accessor, cache, index = await _seeded()
    manager = CacheManager(cache, index, "/data/", True)
    prev = push_cache_manager(manager)
    try:
        await rm_r(accessor, _spec("/a"))
    finally:
        push_cache_manager(prev)
    return (
        (await index.list_dir("/data/a/b")).entries is not None,
        await cache.exists("/data/a/b/f.txt"),
        (await index.list_dir("/data/a")).entries is not None,
    )


@pytest.mark.asyncio
async def test_rm_r_evicts_listings_and_bodies_inside_the_subtree():
    # A recursive remove takes directories the caller never named, and
    # their listings were cached independently: evicting only the target
    # and its parent leaves `/data/a/b` answering for a directory the
    # backend no longer has.
    nested, body, own = await _rm_r_case()
    assert nested is False
    assert body is False
    assert own is False
