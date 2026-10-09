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

from mirage.commands.config import Command
from mirage.commands.spec import CommandSpec, Operand
from mirage.io.types import IOResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

_SPEC = CommandSpec(rest=Operand(type="path"))


def _make_ws():
    ws = Workspace(
        {
            "/m1": (RAMVFS(), MountMode.WRITE),
            "/m2": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    return ws


def _seed(ws):
    asyncio.run(ws.vfs.write("/m1/a.txt", b"aaa\n"))
    asyncio.run(ws.vfs.write("/m2/b.txt", b"bbb\n"))


async def _noop_fn(store, paths, *texts, stdin=None, **kw):
    return b"ok", IOResult()


def _register_on_both(ws, rc):
    ws._registry.mount_for("/m1/").register(rc)
    ws._registry.mount_for("/m2/").register(rc)


def test_cross_vfs_no_aggregate_returns_error():
    ws = _make_ws()
    _seed(ws)
    rc = Command("nocross", spec=_SPEC, vfs="ram", filetype=None, fn=_noop_fn)
    _register_on_both(ws, rc)
    io = asyncio.run(ws.shell("nocross /m1/a.txt /m2/b.txt"))
    assert io.exit_code == 1
    assert b"cross-mount not supported" in io.stderr


def test_cross_vfs_no_aggregate_names_mounts():
    ws = _make_ws()
    _seed(ws)
    rc = Command("nocross", spec=_SPEC, vfs="ram", filetype=None, fn=_noop_fn)
    _register_on_both(ws, rc)
    io = asyncio.run(ws.shell("nocross /m1/a.txt /m2/b.txt"))
    stderr = io.stderr.decode()
    assert "/m1" in stderr
    assert "/m2" in stderr


def test_cross_vfs_with_aggregate_works():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.shell("cat /m1/a.txt /m2/b.txt"))
    assert io.exit_code == 0


def test_cross_vfs_single_mount_still_works():
    ws = _make_ws()
    _seed(ws)
    rc = Command("nocross", spec=_SPEC, vfs="ram", filetype=None, fn=_noop_fn)
    _register_on_both(ws, rc)
    io = asyncio.run(ws.shell("nocross /m1/a.txt"))
    assert io.exit_code == 0


def test_cross_vfs_three_mounts():
    ws = Workspace(
        {
            "/m1": (RAMVFS(), MountMode.WRITE),
            "/m2": (RAMVFS(), MountMode.WRITE),
            "/m3": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.vfs.write("/m1/a.txt", b"a"))
    asyncio.run(ws.vfs.write("/m2/b.txt", b"b"))
    asyncio.run(ws.vfs.write("/m3/c.txt", b"c"))
    rc = Command("nocross", spec=_SPEC, vfs="ram", filetype=None, fn=_noop_fn)
    ws._registry.mount_for("/m1/").register(rc)
    ws._registry.mount_for("/m2/").register(rc)
    ws._registry.mount_for("/m3/").register(rc)
    io = asyncio.run(ws.shell("nocross /m1/a.txt /m2/b.txt /m3/c.txt"))
    assert io.exit_code == 1
    stderr = io.stderr.decode()
    assert "/m1" in stderr or "/m2" in stderr or "/m3" in stderr


def test_aggregate_partial_failure_propagates_exit_code():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.shell("cat /m1/a.txt /m2/missing.txt"))
    assert io.exit_code != 0
    assert asyncio.run(io.stdout_str()) == "aaa\n"
    assert b"missing.txt" in io.stderr
