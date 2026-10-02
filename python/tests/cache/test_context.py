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
import contextlib

import pytest

from mirage.cache.context import (
    active_cache_manager,
    evict_after,
    invalidate_after_unlink,
    invalidate_after_write,
    invalidate_ancestors,
    invalidate_subtree,
    listing_refreshed,
    push_cache_manager,
    settle_after_write,
    write_generation,
)
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.cache.types import WriteReceipt
from mirage.types import PathSpec


def _run(coro):
    return asyncio.run(coro)


class FakeManager:
    def listing_trusted(self, _folder: str) -> bool:
        return False

    def probed_stat(self, _path):
        return None

    def __init__(self) -> None:
        self.writes: list[PathSpec] = []
        self.unlinks: list[PathSpec] = []
        self.subtrees: list[PathSpec] = []
        self.ancestors: list[PathSpec] = []

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.unlinks.append(path)

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        self.ancestors.append(path)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.subtrees.append(path)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"),
        virtual=virtual,
        directory="/",
        pattern=None,
        resolved=True,
    )


async def _delegates() -> FakeManager:
    manager = FakeManager()
    prev = push_cache_manager(manager)
    await invalidate_after_write(_spec("/a.txt"))
    await invalidate_after_unlink(_spec("/b.txt"))
    await invalidate_subtree(_spec("/c"))
    push_cache_manager(prev)
    return manager


def test_delegates_to_active_manager():
    manager = _run(_delegates())
    assert [p.mount_path for p in manager.writes] == ["/a.txt"]
    assert [p.mount_path for p in manager.unlinks] == ["/b.txt"]
    assert [p.mount_path for p in manager.subtrees] == ["/c"]


async def _noop_without_manager() -> None:
    push_cache_manager(None)
    await invalidate_after_write(_spec("/a.txt"))
    await invalidate_after_unlink(_spec("/b.txt"))
    await invalidate_subtree(_spec("/c"))
    await invalidate_ancestors(_spec("/c/d"))


def test_noop_without_active_manager():
    _run(_noop_without_manager())


async def _push_restores() -> tuple[object, object, object]:
    first = FakeManager()
    second = FakeManager()
    prev0 = push_cache_manager(first)
    prev1 = push_cache_manager(second)
    active = active_cache_manager()
    push_cache_manager(prev1)
    restored = active_cache_manager()
    push_cache_manager(prev0)
    return prev1, active, restored


def test_push_returns_previous_manager():
    prev1, active, restored = _run(_push_restores())
    assert prev1 is not None
    assert active is not restored
    assert restored is prev1


async def _ancestors() -> FakeManager:
    manager = FakeManager()
    prev = push_cache_manager(manager)
    await invalidate_ancestors(
        PathSpec(
            vfs_path="data/a/b.txt",
            virtual="/data/data/a/b.txt",
            directory="/data/data/a",
        )
    )
    push_cache_manager(prev)
    return manager


def test_invalidate_ancestors_preserves_virtual_path():
    manager = _run(_ancestors())
    assert [p.virtual for p in manager.ancestors] == ["/data/data/a/b.txt"]
    assert manager.writes == []


async def _repeated_mount_case(prefix: str) -> None:
    index = RAMIndexCacheStore(ttl=600)
    manager = CacheManager(None, index, prefix, True)
    directory = prefix + prefix + "/a"
    ancestors = [prefix, prefix + prefix, directory]
    for ancestor in ancestors:
        await index.set_dir(ancestor, [])
    await index.set_dir(prefix + "/unrelated", [])
    path = PathSpec(
        vfs_path=directory[len(prefix) :].strip("/") + "/b.txt",
        virtual=directory + "/b.txt",
        directory=directory,
    )
    previous = push_cache_manager(manager)
    try:
        await invalidate_after_write(path)
        await invalidate_ancestors(path)
    finally:
        push_cache_manager(previous)
    for ancestor in ancestors:
        assert (await index.list_dir(ancestor)).entries is None
    assert (await index.list_dir(prefix + "/unrelated")).entries is not None


@pytest.mark.parametrize("prefix", ["/data", "/nested/data"])
def test_ancestor_eviction_with_repeated_mount_name(prefix: str):
    _run(_repeated_mount_case(prefix))


@pytest.mark.asyncio
async def test_listing_refreshed_follows_the_managers_listing_rule(
    monkeypatch,
):
    # github's truncated-tree walk asks here rather than through the gate, so
    # a read that belongs to no command trusts a listing for the window too.
    now = [100.0]
    monkeypatch.setattr("mirage.cache.manager._now", lambda: now[0])
    index = RAMIndexCacheStore(ttl=600)
    manager = CacheManager(RAMFileCacheStore(), index, "/data/", True)
    await manager.scope_index(index).set_dir("/data", [])
    prev = push_cache_manager(manager)
    try:
        assert listing_refreshed("/data") is True
        now[0] += LISTING_TRUST_WINDOW
        assert listing_refreshed("/data") is False
    finally:
        push_cache_manager(prev)


class _OpFailed(Exception):
    pass


class _EvictFailed(Exception):
    pass


async def _op(error: type[Exception] | None) -> str:
    if error is not None:
        raise error
    return "done"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "op_error, evict_breaks, raised, seen",
    [
        (None, False, None, "done"),
        (_OpFailed, False, _OpFailed, None),
        (_OpFailed, True, _OpFailed, None),
        (None, True, _EvictFailed, "done"),
    ],
)
async def test_evict_after_evicts_and_keeps_the_ops_error(
    op_error, evict_breaks, raised, seen
):
    # The op's own error wins over an eviction that fails after it.
    results = []

    async def evict(result: str | None) -> None:
        results.append(result)
        if evict_breaks:
            raise _EvictFailed

    with pytest.raises(raised) if raised else contextlib.nullcontext():
        assert await evict_after(_op(op_error), evict) == "done"
    assert results == [seen]


@pytest.mark.asyncio
async def test_settle_and_generation_are_noops_without_an_active_manager():
    prev = push_cache_manager(None)
    try:
        assert write_generation() is None
        await settle_after_write(
            _spec("/a.txt"), b"x", WriteReceipt(1, "t"), None
        )
    finally:
        push_cache_manager(prev)


@pytest.mark.asyncio
async def test_settle_reaches_the_active_manager_with_its_generation():
    cache = RAMFileCacheStore()
    manager = CacheManager(cache, RAMIndexCacheStore(ttl=600), "/", True)
    prev = push_cache_manager(manager)
    try:
        generation = write_generation()
        assert generation == manager.generation
        await settle_after_write(
            _spec("/a.txt"), b"x", WriteReceipt(1, "t"), generation
        )
    finally:
        push_cache_manager(prev)
    assert await cache.get("/a.txt") == b"x"
