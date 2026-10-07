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
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.generic.rg import rg_generic
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic.wc import format_multi
from mirage.commands.config import CommandOpts
from mirage.errors.fs import eacces
from mirage.io.types import materialize
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key

_PAYLOAD = b"alpha\nbeta\n"


class _CountingReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.calls = 0

    async def __call__(self, path, *args, **kwargs) -> bytes:
        self.calls += 1
        return self.data


def _spec() -> PathSpec:
    return PathSpec(
        vfs_path=mount_key("/s3/a.txt", "/s3/"),
        virtual="/s3/a.txt",
        directory="/s3/",
    )


async def _warm_manager() -> CacheManager:
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", _PAYLOAD)
    return CacheManager(cache, None, "/s3/", True)


async def _stat(path) -> FileStat:
    return FileStat(
        name="a.txt",
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=len(_PAYLOAD),
    )


async def _readdir(path) -> list[str]:
    return ["/s3/a.txt"]


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


async def _refused_read(path: PathSpec) -> bytes:
    raise eacces(path.virtual)


async def _refused_stream(path: PathSpec):
    yield await _refused_read(path)


@pytest.mark.asyncio
@pytest.mark.parametrize("generic", [grep_generic, rg_generic])
@pytest.mark.parametrize("stream", [None, _refused_stream])
async def test_search_cannot_skip_a_refused_reader_with_a_warm_cache(
    generic, stream
):
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out, io = await generic(
            [_spec()],
            ("alpha",),
            CommandOpts(),
            readdir=_readdir,
            stat=_stat,
            read_bytes=_refused_read,
            read_stream=stream,
        )
        if generic is grep_generic and stream is not None:
            with pytest.raises(PermissionError):
                await materialize(out)
            return
        assert not await materialize(out)
    finally:
        push_cache_manager(prev)
    assert io.exit_code == 2
    assert b"Permission denied" in await materialize(io.stderr)


@pytest.mark.asyncio
async def test_head_multi_uses_its_injected_reader_with_a_warm_cache():
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
    assert reader.calls == 1


@pytest.mark.asyncio
async def test_tail_multi_uses_its_injected_reader_with_a_warm_cache():
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    source = tail_multi([_spec()], read=reader, n=1)
    push_cache_manager(prev)
    out = await _drain(source)
    assert out == b"beta\n"
    assert reader.calls == 1


@pytest.mark.asyncio
async def test_wc_format_multi_uses_its_injected_reader_with_a_warm_cache():
    reader = _CountingReader(_PAYLOAD)
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out, err, _ = await format_multi([_spec()], read=reader, lines=True)
    finally:
        push_cache_manager(prev)
    assert b"2" in out
    assert err == b""
    assert reader.calls == 1


@pytest.mark.asyncio
async def test_generic_grep_uses_its_injected_reader_with_a_warm_cache():
    reader = _CountingReader(b"fresh alpha\n")
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out, io = await grep_generic(
            [_spec()],
            ("alpha",),
            CommandOpts(),
            readdir=_readdir,
            stat=_stat,
            read_bytes=reader,
            read_stream=None,
        )
    finally:
        push_cache_manager(prev)
    assert await materialize(out) == b"fresh alpha\n"
    assert reader.calls == 1


@pytest.mark.asyncio
async def test_generic_rg_uses_its_injected_reader_with_a_warm_cache():
    reader = _CountingReader(b"fresh alpha\n")
    manager = await _warm_manager()
    prev = push_cache_manager(manager)
    try:
        out, io = await rg_generic(
            [_spec()],
            ("alpha",),
            CommandOpts(),
            readdir=_readdir,
            stat=_stat,
            read_bytes=reader,
            read_stream=None,
        )
    finally:
        push_cache_manager(prev)
    assert await materialize(out) == b"fresh alpha\n"
    assert reader.calls == 1


@pytest.mark.asyncio
async def test_generic_grep_awaits_byte_reader_before_returning():
    reader = _CountingReader(_PAYLOAD)
    out, io = await grep_generic(
        [_spec()],
        ("alpha",),
        CommandOpts(),
        readdir=_readdir,
        stat=_stat,
        read_bytes=reader,
        read_stream=None,
    )
    assert reader.calls == 1
    assert await materialize(out) == b"alpha\n"
    assert io.exit_code == 0
