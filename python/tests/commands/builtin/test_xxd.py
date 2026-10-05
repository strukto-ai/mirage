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

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.driver_ops import ops


def _ws(**files):
    mem = RAMVFS()
    for path, data in files.items():
        asyncio.run(ops(mem).write(PathSpec.from_str_path(path), data=data))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_xxd_plain():
    ws = _ws(**{"/f.txt": b"AB"})
    stdout, _ = _run_raw(ws, "xxd -p /data/f.txt")
    assert _bytes(stdout).strip() == b"4142"


def test_xxd_reverse():
    ws = _ws()
    stdout, _ = _run_raw(ws, "xxd -r -p", stdin=b"4142")
    assert _bytes(stdout) == b"AB"


def test_xxd_u():
    ws = _ws()
    stdout, _ = _run_raw(ws, "xxd -u", stdin=b"\xab\xcd")
    result = _bytes(stdout).decode()
    assert "AB" in result or "CD" in result


def test_xxd_outfile_is_replaced_by_the_dump():
    ws = _ws(**{"/in": b"hi\n", "/out": b"old old old\n"})
    stdout, io = _run_raw(ws, "xxd /data/in /data/out")
    assert _bytes(stdout or b"") == b""
    assert io.exit_code == 0
    cat, _ = _run_raw(ws, "cat /data/out")
    assert _bytes(cat) == (
        b"00000000: 6869 0a                                  hi.\n"
    )


def test_xxd_reverse_writes_into_outfile_at_its_offsets():
    ws = _ws(**{"/out": b"ABCDEFGH"})
    _, io = _run_raw(ws, "xxd -r - /data/out", stdin=b"00000004: 6869  hi\n")
    assert io.exit_code == 0
    cat, _ = _run_raw(ws, "cat /data/out")
    assert _bytes(cat) == b"ABCDhiGH"


def test_xxd_reverse_stream_fills_forward_and_refuses_backward():
    ws = _ws()
    stdout, io = _run_raw(
        ws,
        "xxd -r",
        stdin=b"00000002: 6869  hi\n00000000: 4142  AB\n",
    )
    assert _bytes(stdout) == b"\x00\x00hi"
    assert io.exit_code == 5
    assert asyncio.run(io.stderr_str()) == (
        "xxd: Sorry, cannot seek backwards.\n"
    )
