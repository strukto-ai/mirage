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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _ws():
    mem = RAMResource()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.execute(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_mktemp_creates_file():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "mktemp")
    path = _bytes(stdout).strip().decode()
    assert path.startswith("/tmp/")
    assert io.exit_code == 0


def test_mktemp_with_dir():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "mktemp -d")
    path = _bytes(stdout).strip().decode()
    assert path.startswith("/tmp/")
    assert io.exit_code == 0


def test_mktemp_explicit_path_template():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "mkdir -p /data/mt && mktemp /data/mt/f.XXXX")
    path = _bytes(stdout).strip().decode()
    assert path.startswith("/data/mt/f.")
    assert io.exit_code == 0


def test_mktemp_d_explicit_path_template():
    ws, _ = _ws()
    stdout, io = _run_raw(ws,
                          "mkdir -p /data/mtd && mktemp -d /data/mtd/t.XXXX")
    path = _bytes(stdout).strip().decode()
    assert path.startswith("/data/mtd/t.")
    assert io.exit_code == 0
