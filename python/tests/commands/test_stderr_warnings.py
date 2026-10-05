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

import pytest

from mirage.commands.builtin.generic.rg import rg_generic
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _make_readdir(tree):

    def readdir(path):
        if path in tree:
            return tree[path]
        raise FileNotFoundError(path)

    return readdir


def _make_stat(files):

    def stat_fn(path):
        if path in files:
            return files[path]
        raise FileNotFoundError(path)

    return stat_fn


@pytest.mark.anyio
async def test_rg_scan_collects_warnings_on_unreadable_file():

    async def read_bytes(path):
        if path.virtual == "/good.py":
            return b"hello world\n"
        raise FileNotFoundError(path.virtual)

    readdir = _make_readdir({"/": ["/good.py", "/bad.py"]})
    stat_fn = _make_stat(
        {
            "/good.py": FileStat(
                name="good.py",
                size=12,
                modified=None,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
            "/bad.py": FileStat(
                name="bad.py",
                size=10,
                modified=None,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
        }
    )

    async def async_readdir(path):
        return readdir(path.virtual)

    async def async_stat(path):
        return stat_fn(path.virtual)

    # The scan reports the file it could not read and keeps searching.
    out, io = await rg_generic(
        [PathSpec.from_str_path("/")],
        ["hello"],
        CommandOpts(),
        readdir=async_readdir,
        stat=async_stat,
        read_bytes=read_bytes,
        read_stream=None,
    )
    results = (await materialize(out)).decode().splitlines()
    warnings = (await materialize(io.stderr)).decode().splitlines()
    assert any("hello" in r for r in results)
    assert len(warnings) == 1
    assert "/bad.py" in warnings[0]


async def _seed_ws(ws):
    await ws.dispatch("mkdir", PathSpec.from_str_path("/data"))
    await ws.dispatch(
        "write",
        PathSpec.from_str_path("/data/hello.txt"),
        data=b"hello world\nfoo bar\n",
    )


def _ws():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    asyncio.run(_seed_ws(ws))
    return ws


def test_find_command_stderr_on_missing_dir():
    ws = _ws()

    async def _run():
        result = await ws.shell("find /nonexistent")
        assert result.exit_code == 1
        assert b"nonexistent" in await result.materialize_stderr()

    asyncio.run(_run())


def test_grep_command_stderr_on_missing_file():
    ws = _ws()

    async def _run():
        result = await ws.shell("grep hello /nonexistent")
        # GNU grep exits 2 for an operand it could not search.
        assert result.exit_code == 2
        assert b"nonexistent" in await result.materialize_stderr()

    asyncio.run(_run())


def test_ls_command_stderr_on_missing_dir():
    ws = _ws()

    async def _run():
        result = await ws.shell("ls /nonexistent")
        # GNU ls exits 2 for an inaccessible command-line operand.
        assert result.exit_code == 2
        assert b"nonexistent" in await result.materialize_stderr()

    asyncio.run(_run())
