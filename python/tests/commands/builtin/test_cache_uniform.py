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

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.config import CommandOpts
from mirage.io.types import materialize
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /c/a.txt",
        "head -n 1 /c/a.txt",
        "tail -n 1 /c/a.txt",
        "wc -l /c/a.txt",
        "grep alpha /c/a.txt",
        "rg alpha /c/a.txt",
    ],
)
async def test_a_warm_read_command_reads_nothing_from_the_backend(line):
    # Every read command reads at the door, which serves the warm entry
    # whatever reader the command binds.
    ram = RAMVFS()
    ram.caches_reads = True
    ws = Workspace({"/c": ram}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf 'alpha\\nbeta\\n' > /c/a.txt")
        await (await ws.shell("cat /c/a.txt")).stdout_str()
        reads: list[str] = []
        read, read_stream = ram.read, ram.read_stream

        async def counted_read(path, *args, **kwargs):
            reads.append(path.virtual)
            return await read(path, *args, **kwargs)

        def counted_stream(path, *args, **kwargs):
            reads.append(path.virtual)
            return read_stream(path, *args, **kwargs)

        ram.read, ram.read_stream = counted_read, counted_stream
        out = await ws.shell(line)
        assert await out.stdout_str()
        assert out.exit_code == 0
        assert reads == []
    finally:
        await ws.close()


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
