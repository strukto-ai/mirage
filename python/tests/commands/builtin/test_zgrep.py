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
import gzip

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


def test_zgrep():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\nbaz\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    stdout, io = _run_raw(ws, "zgrep bar /data/f.gz")
    assert _bytes(stdout).strip() == b"bar"


def test_zgrep_no_match():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    stdout, io = _run_raw(ws, "zgrep xyz /data/f.gz")
    assert io.exit_code == 1


def test_zgrep_dash_f_pattern_file():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\nbaz\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    _run_raw(ws, "tee /data/pats.txt", stdin=b"bar\nbaz\n")
    stdout, io = _run_raw(ws, "zgrep -f /data/pats.txt /data/f.gz")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"bar\nbaz\n"


def test_zgrep_dash_e_and_dash_f_union():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\nbaz\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    _run_raw(ws, "tee /data/pats.txt", stdin=b"baz\n")
    stdout, io = _run_raw(ws, "zgrep -e foo -f /data/pats.txt /data/f.gz")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"foo\nbaz\n"


def test_zgrep_stdin_h_labels_standard_input():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\n")
    stdout, io = _run_raw(ws, "zgrep -H bar", stdin=compressed)
    assert _bytes(stdout) == b"(standard input):bar\n"
    assert io.exit_code == 0
