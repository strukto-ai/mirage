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
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic.wc import format_multi
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec

_PAYLOAD = b"alpha\nbeta\n"


class _CountingReader:

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.calls = 0

    async def __call__(self, accessor, path, *args, **kwargs) -> bytes:
        self.calls += 1
        return self.data


def _spec() -> PathSpec:
    return PathSpec(original="/s3/a.txt", directory="/s3/", prefix="/s3/")


async def _warm_manager() -> CacheManager:
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", _PAYLOAD)
    return CacheManager(cache, None, "/s3/", True)


async def _stat(accessor, path, index=None) -> FileStat:
    return FileStat(name="a.txt", type=FileType.TEXT, size=len(_PAYLOAD))


async def _readdir(accessor, path, index=None) -> list[str]:
    return ["/s3/a.txt"]


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


# Every read-content command funnels its file read through one of these shared
# consumers, which wrap the injected reader with cache_aware_* at the choke
# point. A backend can therefore pass a RAW reader and warm reads still serve
# from cache. These tests pin that guarantee: with a warm manager active, the
# consumer must NOT call the backend reader. If a consumer loses its wrap, the
# call count goes non-zero and the matching test fails.


@pytest.mark.asyncio
async def test_head_multi_serves_cache_without_backend():
    # head_multi is built in-scope but drained AFTER the manager scope is
    # popped (mirroring the mount lifecycle), so this also pins eager capture:
    # a lazily-captured manager would be gone by drain and the read would miss.
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    source = head_multi([_spec()], read=reader, n=1)
    push_cache_manager(prev)
    out = await _drain(source)
    assert out == b"alpha\n"
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_tail_multi_serves_cache_without_backend():
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    source = tail_multi([_spec()], read=reader, n=1)
    push_cache_manager(prev)
    out = await _drain(source)
    assert out == b"beta\n"
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_wc_format_multi_serves_cache_without_backend():
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out = await format_multi([_spec()], read=reader, args_l=True)
    finally:
        push_cache_manager(prev)
    assert b"2" in out
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_generic_grep_serves_cache_without_backend():
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out, io = await generic_grep([_spec()], ("alpha", ), {},
                                     readdir=_readdir,
                                     stat=_stat,
                                     read_bytes=reader,
                                     read_stream=None)
    finally:
        push_cache_manager(prev)
    assert b"alpha" in await materialize(out)
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_generic_rg_serves_cache_without_backend():
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out, io = await generic_rg([_spec()], ("alpha", ), {},
                                   readdir=_readdir,
                                   stat=_stat,
                                   read_bytes=reader,
                                   read_stream=None)
    finally:
        push_cache_manager(prev)
    assert b"alpha" in await materialize(out)
    assert reader.calls == 0
