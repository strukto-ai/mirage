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


def test_patch_apply():
    ws = _ws(**{"/hello.txt": b"hello\nworld\n"})
    diff_text = ("--- a/hello.txt\n"
                 "+++ b/hello.txt\n"
                 "@@ -1,2 +1,2 @@\n"
                 " hello\n"
                 "-world\n"
                 "+universe\n")
    _run_raw(ws, "patch -p1", cwd="/data", stdin=diff_text.encode())
    stdout, _ = _run_raw(ws, "cat /data/hello.txt")
    assert b"universe" in _bytes(stdout)


def test_patch_i():
    diff_text = ("--- a/hello.txt\n"
                 "+++ b/hello.txt\n"
                 "@@ -1,2 +1,2 @@\n"
                 " hello\n"
                 "-world\n"
                 "+universe\n")
    ws = _ws(**{
        "/hello.txt": b"hello\nworld\n",
        "/fix.patch": diff_text.encode()
    })
    _run_raw(ws, "patch -p1 -i /data/fix.patch", cwd="/data")
    stdout, _ = _run_raw(ws, "cat /data/hello.txt")
    assert b"universe" in _bytes(stdout)


def test_patch_N():
    diff_text = ("--- a/hello.txt\n"
                 "+++ b/hello.txt\n"
                 "@@ -1,2 +1,2 @@\n"
                 " hello\n"
                 "-world\n"
                 "+universe\n")
    ws = _ws(**{"/hello.txt": b"hello\nuniverse\n"})
    _run_raw(ws, "patch -p1 -N", cwd="/data", stdin=diff_text.encode())
    stdout, _ = _run_raw(ws, "cat /data/hello.txt")
    assert b"universe" in _bytes(stdout)
