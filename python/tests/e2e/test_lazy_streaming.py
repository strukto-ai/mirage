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
    asyncio.run(
        mem.write(PathSpec.from_str_path("/big.txt"),
                  data=b"\n".join(f"line {i}".encode() for i in range(10000))))
    asyncio.run(
        mem.write(PathSpec.from_str_path("/small.txt"),
                  data=b"apple\nbanana\napricot\ncherry\n"))
    asyncio.run(
        mem.write(PathSpec.from_str_path("/dupes.txt"),
                  data=b"a\na\nb\nb\nc\n"))
    asyncio.run(
        mem.write(PathSpec.from_str_path("/csv.txt"),
                  data=b"name,age,city\nalice,30,nyc\nbob,25,sf\n"))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


@pytest.mark.asyncio
async def test_cat_grep_head_streams(ws):
    io = await ws.execute("cat /data/big.txt | grep 'line 1' | head -n 3")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 3


@pytest.mark.asyncio
async def test_cat_head_early_termination(ws):
    io = await ws.execute("cat /data/big.txt | head -n 5")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 5
    assert lines[0] == "line 0"


@pytest.mark.asyncio
async def test_cat_cut_head(ws):
    io = await ws.execute("cat /data/csv.txt | cut -d , -f 1 | head -n 2")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 2
    assert lines[0] == "name"
    assert lines[1] == "alice"


@pytest.mark.asyncio
async def test_cat_sort_head(ws):
    io = await ws.execute("cat /data/small.txt | sort | head -n 2")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 2
    assert lines == sorted(lines)


@pytest.mark.asyncio
async def test_cat_uniq(ws):
    io = await ws.execute("cat /data/dupes.txt | uniq")
    lines = (await io.stdout_str()).strip().split("\n")
    assert lines == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_cat_tr_grep(ws):
    io = await ws.execute("cat /data/small.txt | tr a A | grep Ap")
    result = await io.stdout_str()
    assert "Apple" in result or "Apricot" in result


@pytest.mark.asyncio
async def test_cat_grep_wc_l(ws):
    io = await ws.execute("cat /data/small.txt | grep a | wc -l")
    assert (await io.stdout_str()).strip() == "3"


@pytest.mark.asyncio
async def test_find_path_output(ws):
    io = await ws.execute("find /data -name '*.txt'")
    result = await io.stdout_str()
    assert "/data/" in result


def test_execute_via_asyncio_run(ws):

    async def _run():
        io = await ws.execute("cat /data/small.txt | head -n 2")
        return (await io.stdout_str()).strip().split("\n")

    lines = asyncio.run(_run())
    assert len(lines) == 2
