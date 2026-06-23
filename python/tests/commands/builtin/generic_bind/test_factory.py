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

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.factory import with_read_cache
from mirage.types import PathSpec


class _CountingBackend:

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.stream_calls = 0
        self.bytes_calls = 0

    async def read_stream(self, accessor, path, *args, **kwargs):
        self.stream_calls += 1
        yield self.data

    async def read_bytes(self, accessor, path, *args, **kwargs) -> bytes:
        self.bytes_calls += 1
        return self.data


async def _noop_readdir(accessor, path, index=None) -> list[str]:
    return []


async def _noop_stat(accessor, path, index=None):
    return None


def _ops(backend: _CountingBackend) -> CommandIO:
    return CommandIO(
        readdir=_noop_readdir,
        read_bytes=backend.read_bytes,
        read_stream=backend.read_stream,
        stat=_noop_stat,
        is_mounted=lambda a: True,
        local=False,
    )


def _spec() -> PathSpec:
    return PathSpec(original="/s3/a.txt", directory="/s3/", prefix="/s3/")


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


@pytest.mark.asyncio
async def test_warm_read_stream_serves_cache_without_backend():
    backend = _CountingBackend(b"payload")
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", b"payload")
    manager = CacheManager(cache, None, "/s3/", True)
    ops = with_read_cache(_ops(backend))
    prev = push_cache_manager(manager)
    try:
        out = await _drain(ops.read_stream(None, _spec()))
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.stream_calls == 0


@pytest.mark.asyncio
async def test_warm_read_bytes_serves_cache_without_backend():
    backend = _CountingBackend(b"payload")
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", b"payload")
    manager = CacheManager(cache, None, "/s3/", True)
    ops = with_read_cache(_ops(backend))
    prev = push_cache_manager(manager)
    try:
        out = await ops.read_bytes(None, _spec())
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.bytes_calls == 0


@pytest.mark.asyncio
async def test_cold_read_falls_through_to_backend():
    backend = _CountingBackend(b"payload")
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    ops = with_read_cache(_ops(backend))
    prev = push_cache_manager(manager)
    try:
        out = await _drain(ops.read_stream(None, _spec()))
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.stream_calls == 1


@pytest.mark.asyncio
async def test_no_manager_falls_through_to_backend():
    backend = _CountingBackend(b"payload")
    ops = with_read_cache(_ops(backend))
    out = await _drain(ops.read_stream(None, _spec()))
    assert out == b"payload"
    assert backend.stream_calls == 1
