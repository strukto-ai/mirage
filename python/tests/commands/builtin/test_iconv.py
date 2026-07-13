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


def test_iconv_utf8_to_latin1():
    ws, _ = _ws()
    stdout, io = _run_raw(ws,
                          "iconv -f utf-8 -t latin-1",
                          stdin="caf\u00e9\n".encode())
    assert io.exit_code == 0
    assert _bytes(stdout) == "caf\u00e9\n".encode("latin-1")


def test_iconv_output_path_writes_file():
    ws, _ = _ws()
    _run_raw(ws, "bash -c 'echo caf\\xc3\\xa9 > /data/in.txt'")
    _, io = _run_raw(ws,
                     "iconv -f utf-8 -t utf-8 -o /data/out.txt /data/in.txt")
    assert io.exit_code == 0
    stdout, _ = _run_raw(ws, "cat /data/out.txt")
    assert _bytes(stdout).strip() != b""
