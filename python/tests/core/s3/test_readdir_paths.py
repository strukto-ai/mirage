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
from mirage.types import MountMode
from mirage.workspace import Workspace


@pytest.fixture
def ws():
    mem = RAMResource()
    w = Workspace(resources={"/mnt/data": (mem, MountMode.WRITE)})
    asyncio.run(w.execute("mkdir /mnt/data/dir"))
    asyncio.run(w.execute("echo -n a > /mnt/data/dir/a.txt"))
    asyncio.run(w.execute("echo -n b > /mnt/data/dir/b.txt"))
    asyncio.run(w.execute("echo -n c > /mnt/data/c.csv"))
    return w


def test_readdir_returns_leading_slash(ws):
    entries = asyncio.run(ws.fs.readdir("/mnt/data/dir"))
    for e in entries:
        assert e.startswith("/"), f"readdir entry missing leading /: {e}"


def test_readdir_returns_full_virtual_paths(ws):
    entries = asyncio.run(ws.fs.readdir("/mnt/data/dir"))
    assert "/mnt/data/dir/a.txt" in entries
    assert "/mnt/data/dir/b.txt" in entries


def test_readdir_root(ws):
    entries = asyncio.run(ws.fs.readdir("/mnt/data"))
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert "dir" in names
    assert "c.csv" in names


def test_readdir_glob_expansion(ws):

    async def _run():
        io = await ws.execute("echo /mnt/data/dir/*.txt")
        return await io.stdout_str()

    out = asyncio.run(_run()).strip()
    assert "/mnt/data/dir/a.txt" in out
    assert "/mnt/data/dir/b.txt" in out
