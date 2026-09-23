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

from functools import partial

import pytest

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.manager import CacheManager
from mirage.cache.read_through import (cache_aware_read_bytes,
                                       cache_aware_read_stream)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


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
    return PathSpec(vfs_path=mount_key("/s3/a.txt", "/s3/"),
                    virtual="/s3/a.txt",
                    directory="/s3/")


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
        partial(cache_aware_read_stream(backend.read_stream), None), b"pipe")
    prev = push_cache_manager(manager)
    try:
        source = reader(_spec())
    finally:
        push_cache_manager(prev)
    assert await _drain(source) == b"cached"
    assert await _drain(reader(PathSpec.from_str_path("-"))) == b"pipe"
    assert await _drain(reader(PathSpec.from_str_path("-"))) == b""
    assert backend.stream_calls == 0
