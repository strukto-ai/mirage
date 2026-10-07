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
from functools import partial
from unittest.mock import AsyncMock

import pytest

from mirage.cache.context import push_cache_manager
from mirage.cache.file.io import mutation_lock
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.cache.read_through import (
    cache_aware_bound_stream,
    cache_aware_read_bytes,
    cache_aware_read_stream,
)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.session.access import io_context


class _CountingBackend:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.stream_calls = 0
        self.bytes_calls = 0
        self.stream_closed = False

    async def read_stream(self, accessor, path, *args, **kwargs):
        self.stream_calls += 1
        try:
            yield self.data
        finally:
            self.stream_closed = True

    async def read_bytes(self, accessor, path, *args, **kwargs) -> bytes:
        self.bytes_calls += 1
        return self.data


def _spec() -> PathSpec:
    return PathSpec(
        vfs_path=mount_key("/s3/a.txt", "/s3/"),
        virtual="/s3/a.txt",
        directory="/s3/",
    )


async def _warm_manager(data: bytes) -> CacheManager:
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", data)
    return CacheManager(cache, None, "/s3/", True)


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


@pytest.mark.asyncio
async def test_read_bytes_warm_serves_cache_without_backend():
    backend = _CountingBackend(b"payload")
    manager = await _warm_manager(b"payload")
    reader = cache_aware_read_bytes(backend.read_bytes)
    prev = push_cache_manager(manager)
    try:
        out = await reader(None, _spec())
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.bytes_calls == 0


@pytest.mark.asyncio
async def test_read_bytes_cold_falls_through():
    backend = _CountingBackend(b"payload")
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    reader = cache_aware_read_bytes(backend.read_bytes)
    prev = push_cache_manager(manager)
    try:
        out = await reader(None, _spec())
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.bytes_calls == 1


@pytest.mark.asyncio
async def test_read_bytes_no_manager_falls_through():
    backend = _CountingBackend(b"payload")
    reader = cache_aware_read_bytes(backend.read_bytes)
    out = await reader(None, _spec())
    assert out == b"payload"
    assert backend.bytes_calls == 1


@pytest.mark.asyncio
async def test_read_stream_warm_serves_cache_without_backend():
    backend = _CountingBackend(b"payload")
    manager = await _warm_manager(b"payload")
    reader = cache_aware_read_stream(backend.read_stream)
    prev = push_cache_manager(manager)
    try:
        out = await _drain(reader(None, _spec()))
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.stream_calls == 0


@pytest.mark.asyncio
async def test_read_stream_cold_falls_through():
    backend = _CountingBackend(b"payload")
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    reader = cache_aware_read_stream(backend.read_stream)
    prev = push_cache_manager(manager)
    try:
        out = await _drain(reader(None, _spec()))
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.stream_calls == 1


@pytest.mark.asyncio
async def test_read_stream_no_manager_falls_through():
    backend = _CountingBackend(b"payload")
    reader = cache_aware_read_stream(backend.read_stream)
    out = await _drain(reader(None, _spec()))
    assert out == b"payload"
    assert backend.stream_calls == 1


@pytest.mark.asyncio
async def test_read_stream_close_propagates_to_backend():
    backend = _CountingBackend(b"payload")
    reader = cache_aware_read_stream(backend.read_stream)
    source = reader(None, _spec())
    assert await anext(source) == b"payload"
    await source.aclose()
    assert backend.stream_closed


@pytest.mark.asyncio
async def test_read_stream_captures_manager_before_drain():
    # The manager must be captured when the reader is called (inside the
    # mount's scope), not when the stream drains (after the scope is gone).
    backend = _CountingBackend(b"payload")
    manager = await _warm_manager(b"payload")
    reader = cache_aware_read_stream(backend.read_stream)
    prev = push_cache_manager(manager)
    source = reader(None, _spec())
    push_cache_manager(prev)
    out = await _drain(source)
    assert out == b"payload"
    assert backend.stream_calls == 0


@pytest.mark.asyncio
async def test_stdin_wrapper_preserves_file_cache_context():
    backend = _CountingBackend(b"changed")
    manager = await _warm_manager(b"cached")
    reader = stdin_stream(
        partial(cache_aware_read_stream(backend.read_stream), None), b"pipe"
    )
    prev = push_cache_manager(manager)
    try:
        source = reader(_spec())
    finally:
        push_cache_manager(prev)
    assert await _drain(source) == b"cached"
    assert await _drain(reader(PathSpec.from_str_path("-"))) == b"pipe"
    assert await _drain(reader(PathSpec.from_str_path("-"))) == b""
    assert backend.stream_calls == 0


@pytest.mark.asyncio
async def test_complete_read_populates_cache_and_rendered_size():
    backend = _CountingBackend("雪\n".encode())
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    prev = push_cache_manager(manager)
    try:
        reader = cache_aware_read_bytes(backend.read_bytes)
    finally:
        push_cache_manager(prev)
    assert await reader(None, _spec()) == backend.data
    assert await reader(None, _spec()) == backend.data
    assert await manager.cached_size(_spec()) == len(backend.data)
    assert backend.bytes_calls == 1


@pytest.mark.asyncio
async def test_inflight_read_cannot_repopulate_after_mutation():
    manager = CacheManager(
        RAMFileCacheStore(), RAMIndexCacheStore(), "/s3/", True
    )

    async def fetch():
        await manager.invalidate_after_write(_spec())
        return b"old"

    assert await manager.read_through(_spec(), fetch) == b"old"
    assert await manager.cached_bytes(_spec()) is None


@pytest.mark.asyncio
async def test_inflight_read_cannot_repopulate_retired_mount():
    live = True
    manager = CacheManager(
        RAMFileCacheStore(), None, "/s3/", True, owns_path=lambda _: live
    )

    async def fetch():
        nonlocal live
        live = False
        return b"old"

    assert await manager.read_through(_spec(), fetch) == b"old"
    live = True
    assert await manager.cached_bytes(_spec()) is None


@pytest.mark.asyncio
async def test_fill_keeps_nothing_when_keep_turns_false_mid_fetch():
    keepable = True
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)

    async def fetch():
        nonlocal keepable
        keepable = False
        return b"old"

    assert await manager.fill(_spec(), fetch, keep=lambda: keepable) == b"old"
    assert await manager.cached_bytes(_spec()) is None


@pytest.mark.asyncio
async def test_fill_asks_keep_once_it_holds_the_mutation_lock():
    # A fill that fetched waits for the lock behind another holder; what
    # keep answers while it waits is not the answer it must act on.
    keepable = True
    store = RAMFileCacheStore()
    manager = CacheManager(store, None, "/s3/", True)
    fetched = asyncio.Event()

    async def fetch():
        fetched.set()
        return b"old"

    lock = mutation_lock(store)
    await lock.acquire()
    filling = asyncio.ensure_future(
        manager.fill(_spec(), fetch, keep=lambda: keepable)
    )
    try:
        await asyncio.wait_for(fetched.wait(), 1)
        keepable = False
        lock.release()
        assert await asyncio.wait_for(filling, 1) == b"old"
    finally:
        if lock.locked():
            lock.release()
        await asyncio.gather(filling, return_exceptions=True)
    assert await manager.cached_bytes(_spec()) is None


@pytest.mark.asyncio
async def test_failed_read_never_populates_cache():
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)

    fetch = AsyncMock(side_effect=OSError("failed read"))

    with pytest.raises(OSError, match="failed read"):
        await manager.read_through(_spec(), fetch)
    assert await manager.cached_bytes(_spec()) is None


class _RefusingGate:
    scoped = True
    granted = ()

    def check(self, virtual: str) -> None:
        if self.refuses(virtual):
            raise PermissionError(virtual)

    def refuses(self, virtual: str) -> bool:
        return virtual == "/s3/sealed.txt"

    def scopes(self, virtual: str) -> bool:
        return self.refuses(virtual)


@pytest.mark.asyncio
async def test_admission_refuses_warm_reads_before_the_freshness_probe():
    cache = RAMFileCacheStore()
    for name in ("sealed", "open"):
        await cache.set(f"/s3/{name}.txt", b"warm")
    asked = []

    async def probe(key):
        asked.append(key)
        return True

    gate = _RefusingGate()

    async def raw(path):
        gate.check(path.virtual)
        yield b"backend"

    manager = CacheManager(cache, None, "/s3/", True, may_serve_cached=probe)
    reader = cache_aware_bound_stream(raw, io_context(None, gate))
    previous = push_cache_manager(manager)
    try:
        with pytest.raises(PermissionError):
            await _drain(reader(PathSpec.from_str_path("/s3/sealed.txt")))
        assert asked == []
        assert (
            await _drain(reader(PathSpec.from_str_path("/s3/open.txt")))
            == b"warm"
        )
        unrestricted = cache_aware_bound_stream(raw)
        assert (
            await _drain(
                unrestricted(PathSpec.from_str_path("/s3/sealed.txt"))
            )
            == b"warm"
        )
    finally:
        push_cache_manager(previous)
    assert asked == ["/s3/open.txt", "/s3/sealed.txt"]
