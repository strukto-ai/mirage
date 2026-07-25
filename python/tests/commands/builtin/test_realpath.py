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


def test_realpath_absolute():
    ws = _ws()
    stdout, _ = _run_raw(ws, "realpath /data/bar/../baz")
    assert _bytes(stdout).strip() == b"/data/baz"


def test_realpath_e_dotdot_on_mount():
    ws = _ws()
    _run_raw(ws, "bash -c 'mkdir -p /data/sub && echo hi > /data/f.txt'")
    stdout, io = _run_raw(ws, "realpath -e /data/sub/../f.txt")
    assert io.exit_code == 0
    assert _bytes(stdout).strip() == b"/data/f.txt"


def test_realpath_e_missing_fails():
    ws = _ws()
    _, io = _run_raw(ws, "realpath -e /data/nope.txt")
    assert io.exit_code != 0


def test_realpath_e_missing_message_not_doubled():
    # Regression guard: the generic raises a plain (non-fs) error so
    # format_fs_error emits it verbatim; a FileNotFoundError would be
    # re-prefixed and re-suffixed into a doubled message.
    ws = _ws()

    async def go():
        io = await ws.execute("realpath -e /data/nope.txt")
        return io.exit_code, await io.stderr_str()

    code, err = asyncio.run(go())
    assert code == 1
    assert err == "realpath: '/data/nope.txt': No such file or directory\n"
