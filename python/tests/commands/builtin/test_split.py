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
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


def _ws(**files):
    mem = RAMResource()
    for path, data in files.items():
        asyncio.run(mem.write(PathSpec.from_str_path(path), data=data))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.execute(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_split_by_lines():
    ws = _ws(**{"/f.txt": b"a\nb\nc\nd\n"})
    _run_raw(ws, "split -l 2 /data/f.txt /data/chunk_")
    stdout_a, _ = _run_raw(ws, "cat /data/chunk_aa")
    stdout_b, _ = _run_raw(ws, "cat /data/chunk_ab")
    assert _bytes(stdout_a) == b"a\nb\n"
    assert _bytes(stdout_b) == b"c\nd\n"


def test_split_by_bytes():
    ws = _ws(**{"/f.bin": b"ABCDEF"})
    _run_raw(ws, "split -b 2 /data/f.bin /data/p_")
    stdout_a, _ = _run_raw(ws, "cat /data/p_aa")
    stdout_b, _ = _run_raw(ws, "cat /data/p_ab")
    stdout_c, _ = _run_raw(ws, "cat /data/p_ac")
    assert _bytes(stdout_a) == b"AB"
    assert _bytes(stdout_b) == b"CD"
    assert _bytes(stdout_c) == b"EF"


def test_split_d():
    ws = _ws(**{"/f.txt": b"a\nb\nc\nd\n"})
    _run_raw(ws, "split -d -l 2 /data/f.txt /data/part")
    stdout, _ = _run_raw(ws, "ls /data")
    result = _bytes(stdout).decode()
    assert "part00" in result
