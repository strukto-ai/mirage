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
from collections.abc import AsyncIterator

from mirage.commands import COMMANDS as _CMDS
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace

ram_cat = _CMDS["cat"]


def _cat_ops():
    return ram_cat.__wrapped__.args[0]


def _spying_stream(real_stream, pulled: list[str]):

    def factory(accessor, p: PathSpec) -> AsyncIterator[bytes]:
        return _spy_iter(real_stream(accessor, p), p.original, pulled)

    return factory


async def _spy_iter(source: AsyncIterator[bytes], name: str,
                    pulled: list[str]) -> AsyncIterator[bytes]:
    first = True
    async for chunk in source:
        if first:
            pulled.append(name)
            first = False
        yield chunk


def _seeded_ws() -> Workspace:
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)

    async def seed():
        await ws.execute("tee /data/a.txt > /dev/null", stdin=b"a1\na2\na3\n")
        await ws.execute("tee /data/b.txt > /dev/null", stdin=b"b1\nb2\n")

    asyncio.run(seed())
    return ws


def _spy_cat_reads(ws, command, pulled):
    ops = _cat_ops()
    real = ops.read_stream
    object.__setattr__(ops, "read_stream", _spying_stream(real, pulled))
    try:
        return asyncio.run(_run_and_collect(ws, command))
    finally:
        object.__setattr__(ops, "read_stream", real)


async def _run_and_collect(ws, command):
    result = await ws.execute(command)
    out = await result.stdout_str()
    await ws.close()
    return out


def test_multi_cat_head_skips_second_file():
    ws = _seeded_ws()
    pulled: list[str] = []
    out = _spy_cat_reads(ws, "cat /data/a.txt /data/b.txt | head -n 1", pulled)
    assert out == "a1\n"
    assert pulled == ["/data/a.txt"]


def test_multi_cat_full_reads_both_files():
    ws = _seeded_ws()
    pulled: list[str] = []
    out = _spy_cat_reads(ws, "cat /data/a.txt /data/b.txt", pulled)
    assert out == "a1\na2\na3\nb1\nb2\n"
    assert pulled == ["/data/a.txt", "/data/b.txt"]
