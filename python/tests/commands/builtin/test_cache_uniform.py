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

from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.config import Context
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


async def _stat(path) -> FileStat:
    return FileStat(
        name="a.txt",
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=len(_PAYLOAD),
    )


async def _readdir(path) -> list[str]:
    return ["/s3/a.txt"]


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
    # Every read command reads at the dispatcher, which serves the warm entry
    # whatever reader the command binds.
    ram = RAMVFS()
    ram.caches_reads = True
    ws = Workspace({"/c": ram}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf 'alpha\\nbeta\\n' > /c/a.txt")
        await (await ws.shell("cat /c/a.txt")).stdout_str()
        reads: list[str] = []
        read = ram.read

        async def counted_read(path, offset=0, size=None):
            reads.append(path.virtual)
            return await read(path, offset, size)

        ram.read = counted_read
        out = await ws.shell(line)
        assert await out.stdout_str()
        assert out.exit_code == 0
        assert reads == []
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected,code",
    [
        ("tail -n 1 /c/a", "beta\n", 0),
        ("tail -c 5 /c/a", "beta\n", 0),
        ("cmp -l /c/a /c/b", " 1 141 101\n 7 142 102\n", 1),
    ],
)
async def test_sized_commands_use_the_warm_bodys_length(line, expected, code):
    ram = RAMVFS()
    ram.caches_reads = True
    ram.accessor.store.files["/a"] = b"alpha\nbeta\n"
    ram.accessor.store.files["/b"] = b"Alpha\nBeta\n"
    ws = Workspace({"/c": ram}, mode=MountMode.WRITE)
    try:
        await (await ws.shell("cat /c/a /c/b")).stdout_str()
        ram.accessor.store.files["/a"] = b"x"
        ram.accessor.store.files["/b"] = b"y"
        out = await ws.shell(line)
        assert await out.stdout_str() == expected
        assert out.exit_code == code
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_generic_grep_reads_bytes_once_when_drained():
    reader = _CountingReader(_PAYLOAD)
    out, io = await grep_generic(
        [_spec()],
        ("alpha",),
        Context(),
        readdir=_readdir,
        stat=_stat,
        read=reader,
    )
    assert reader.calls == 0
    assert await materialize(out) == b"alpha\n"
    assert reader.calls == 1
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("option", ["-n 1", "-c 4"])
async def test_tail_rechecks_a_stale_listing_size(option):
    ram = RAMVFS()
    ram.index_ttl = 60
    ram.accessor.store.files["/a"] = b"old\n"
    ws = Workspace({"/c": ram}, mode=MountMode.WRITE)
    try:
        await ws.shell("ls /c")
        ram.accessor.store.files["/a"] = b"old\nnew\n"
        out = await ws.shell(f"tail {option} /c/a")
        assert await out.stdout_str() == "new\n"
        assert out.exit_code == 0
    finally:
        await ws.close()
