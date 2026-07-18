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
import gzip as gzip_lib

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
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_gzip_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "gzip", stdin=b"hello world")
    decompressed = gzip_lib.decompress(_bytes(stdout))
    assert decompressed == b"hello world"


def test_gunzip_stdin():
    compressed = gzip_lib.compress(b"hello world")
    ws = _ws()
    stdout, _ = _run_raw(ws, "gunzip", stdin=compressed)
    assert _bytes(stdout) == b"hello world"


def test_gzip_roundtrip_stdin():
    ws = _ws()
    stdout_gz, _ = _run_raw(ws, "gzip", stdin=b"roundtrip test")
    stdout_plain, _ = _run_raw(ws, "gunzip", stdin=_bytes(stdout_gz))
    assert _bytes(stdout_plain) == b"roundtrip test"


def test_gzip_file():
    ws = _ws(**{"/f.txt": b"test content"})
    _, io_result = _run_raw(ws, "gzip /data/f.txt")
    assert "/data/f.txt.gz" in io_result.writes


def test_gunzip_file():
    compressed = gzip_lib.compress(b"original data")
    ws = _ws(**{"/f.txt.gz": compressed})
    _, io_result = _run_raw(ws, "gunzip /data/f.txt.gz")
    assert "/data/f.txt" in io_result.writes
