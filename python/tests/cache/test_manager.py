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

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _run(coro):
    return asyncio.run(coro)


def _stores() -> tuple[RAMFileCacheStore, RAMIndexCacheStore]:
    return RAMFileCacheStore(), RAMIndexCacheStore(ttl=600)


async def _seed(cache: RAMFileCacheStore, index: RAMIndexCacheStore) -> None:
    await cache.set("/data/arch/h.txt", b"two\n")
    await index.set_dir("/data/arch", [
        ("h.txt", IndexEntry(id="h", name="h.txt", resource_type="file")),
    ])


async def _write_case() -> tuple[bool, bool]:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_after_write("/arch/h.txt")
    cached = await cache.exists("/data/arch/h.txt")
    listing = await index.list_dir("/data/arch")
    return cached, listing.entries is not None


def test_write_evicts_file_and_parent_listing():
    cached, listed = _run(_write_case())
    assert cached is False
    assert listed is False


async def _unlink_case() -> tuple[bool, bool, object]:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_after_unlink("/arch/h.txt")
    cached = await cache.exists("/data/arch/h.txt")
    listing = await index.list_dir("/data/arch")
    entry = await index.get("/data/arch/h.txt")
    return cached, listing.entries is not None, entry.entry


def test_unlink_evicts_file_listing_and_entry():
    cached, listed, entry = _run(_unlink_case())
    assert cached is False
    assert listed is False
    assert entry is None


async def _local_case() -> tuple[bool, bool]:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", False)
    await manager.invalidate_after_write("/arch/h.txt")
    cached = await cache.exists("/data/arch/h.txt")
    listing = await index.list_dir("/data/arch")
    return cached, listing.entries is not None


def test_local_mount_keeps_file_cache_but_invalidates_index():
    cached, listed = _run(_local_case())
    assert cached is True
    assert listed is False


async def _pathspec_case() -> bool:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", True)
    spec = PathSpec(resource_path=mount_key("/data/arch/h.txt", "/data/"),
                    virtual="/data/arch/h.txt",
                    directory="/data/arch")
    await manager.invalidate_after_write(spec)
    return await cache.exists("/data/arch/h.txt")


def test_pathspec_input_maps_to_virtual_key():
    assert _run(_pathspec_case()) is False


async def _cached_hit_case() -> bytes | None:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    manager = CacheManager(cache, index, "/data/", True)
    spec = PathSpec(resource_path=mount_key("/data/x.txt", "/data/"),
                    virtual="/data/x.txt",
                    directory="/data/")
    return await manager.cached_bytes(spec)


def test_cached_bytes_returns_cached_value():
    assert _run(_cached_hit_case()) == b"cached"


async def _cached_miss_case() -> bytes | None:
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    spec = PathSpec(resource_path=mount_key("/data/x.txt", "/data/"),
                    virtual="/data/x.txt",
                    directory="/data/")
    return await manager.cached_bytes(spec)


def test_cached_bytes_miss_returns_none():
    assert _run(_cached_miss_case()) is None


async def _cached_local_case() -> bytes | None:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    manager = CacheManager(cache, index, "/data/", False)
    spec = PathSpec(resource_path=mount_key("/data/x.txt", "/data/"),
                    virtual="/data/x.txt",
                    directory="/data/")
    return await manager.cached_bytes(spec)


def test_cached_bytes_local_mount_returns_none():
    assert _run(_cached_local_case()) is None


async def _no_index_case() -> bool:
    cache, _ = _stores()
    await cache.set("/data/a.txt", b"x")
    manager = CacheManager(cache, None, "/data/", True)
    await manager.invalidate_after_write("/a.txt")
    return await cache.exists("/data/a.txt")


def test_missing_index_is_tolerated():
    assert _run(_no_index_case()) is False
