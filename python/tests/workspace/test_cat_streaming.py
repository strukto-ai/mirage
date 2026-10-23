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
import inspect
from collections.abc import AsyncIterator

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _spying_read(real_read, pulled: list[str]):
    def factory(
        p: PathSpec, offset: int = 0, size: int | None = None
    ) -> AsyncIterator[bytes]:
        return _spy_iter(real_read(p, offset, size), p.virtual, pulled)

    return factory


async def _spy_iter(
    answer, name: str, pulled: list[str]
) -> AsyncIterator[bytes]:
    found = await answer if inspect.isawaitable(answer) else answer
    pulled.append(name)
    if isinstance(found, bytes):
        yield found
        return
    async for chunk in found:
        yield chunk


def _seeded_ws() -> Workspace:
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)

    async def seed():
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"a1\na2\na3\n")
        await ws.shell("tee /data/b.txt > /dev/null", stdin=b"b1\nb2\n")

    asyncio.run(seed())
    return ws


def _spy_cat_reads(ws, command, pulled):
    vfs = ws.mount("/data/").vfs
    vfs.read = _spying_read(vfs.read, pulled)
    return asyncio.run(_run_and_collect(ws, command))


async def _run_and_collect(ws, command):
    result = await ws.shell(command)
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
