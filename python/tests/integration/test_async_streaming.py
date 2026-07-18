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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


@pytest.fixture
def ws():
    mem = RAMResource()
    big_content = b"\n".join([f"line {i}".encode() for i in range(10000)])
    asyncio.run(mem.write(PathSpec.from_str_path("/big.txt"),
                          data=big_content))
    asyncio.run(
        mem.write(PathSpec.from_str_path("/small.txt"),
                  data=b"apple\nbanana\napricot\ncherry\n"))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


@pytest.mark.asyncio
async def test_pipe_cat_grep(ws):
    io = await ws.execute("cat /data/small.txt | grep ap")
    result = await io.stdout_str()
    assert "apple" in result
    assert "apricot" in result
    assert "banana" not in result


@pytest.mark.asyncio
async def test_pipe_cat_head_early_termination(ws):
    io = await ws.execute("cat /data/big.txt | head -n 5")
    result = await io.stdout_str()
    lines = result.strip().split("\n")
    assert len(lines) == 5
    assert lines[0] == "line 0"


@pytest.mark.asyncio
async def test_pipe_cat_grep_sort(ws):
    io = await ws.execute("cat /data/small.txt | grep a | sort")
    result = await io.stdout_str()
    lines = result.strip().split("\n")
    assert lines == sorted(lines)


def test_execute_via_asyncio_run(ws):

    async def _run():
        io = await ws.execute("cat /data/small.txt")
        return await io.stdout_str()

    assert "apple" in asyncio.run(_run())


@pytest.mark.asyncio
async def test_pipe_cat_wc(ws):
    io = await ws.execute("cat /data/small.txt | wc -l")
    assert (await io.stdout_str()).strip() == "4"


@pytest.mark.asyncio
async def test_pipe_cat_tail(ws):
    io = await ws.execute("cat /data/big.txt | tail -n 3")
    result = await io.stdout_str()
    lines = result.strip().split("\n")
    assert len(lines) == 3
    assert lines[-1] == "line 9999"


@pytest.mark.asyncio
async def test_pipe_cat_sort_uniq(ws):
    io = await ws.execute("cat /data/small.txt | sort | uniq")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == len(set(lines))
