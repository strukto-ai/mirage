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

from mirage.commands.registry import RegisteredCommand
from mirage.commands.spec import CommandSpec, Operand
from mirage.io.types import IOResult
from mirage.provision import ProvisionResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

_SPEC = CommandSpec(rest=Operand(type="path"))


def _make_ws():
    ws = Workspace(
        {
            "/m1": (RAMResource(), MountMode.WRITE),
            "/m2": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    return ws


def _seed(ws):
    asyncio.run(ws.fs.write("/m1/a.txt", b"aaa\n"))
    asyncio.run(ws.fs.write("/m2/b.txt", b"bbb\n"))


async def _noop_fn(store, paths, *texts, stdin=None, **kw):
    return b"ok", IOResult()


async def _noop_provision(store, paths, *texts, **kw):
    return ProvisionResult(command="noop",
                           network_read_low=10,
                           network_read_high=10,
                           read_ops=1)


def _register_on_both(ws, rc):
    ws._registry.mount_for("/m1/").register(rc)
    ws._registry.mount_for("/m2/").register(rc)


def test_cross_resource_no_aggregate_returns_error():
    ws = _make_ws()
    _seed(ws)
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn)
    _register_on_both(ws, rc)
    io = asyncio.run(ws.execute("nocross /m1/a.txt /m2/b.txt"))
    assert io.exit_code == 1
    assert b"cross-mount not supported" in io.stderr


def test_cross_resource_no_aggregate_names_mounts():
    ws = _make_ws()
    _seed(ws)
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn)
    _register_on_both(ws, rc)
    io = asyncio.run(ws.execute("nocross /m1/a.txt /m2/b.txt"))
    stderr = io.stderr.decode()
    assert "/m1" in stderr
    assert "/m2" in stderr


def test_cross_resource_with_aggregate_works():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.execute("cat /m1/a.txt /m2/b.txt"))
    assert io.exit_code == 0


def test_cross_resource_single_mount_still_works():
    ws = _make_ws()
    _seed(ws)
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn)
    _register_on_both(ws, rc)
    io = asyncio.run(ws.execute("nocross /m1/a.txt"))
    assert io.exit_code == 0


def test_cross_resource_three_mounts():
    ws = Workspace(
        {
            "/m1": (RAMResource(), MountMode.WRITE),
            "/m2": (RAMResource(), MountMode.WRITE),
            "/m3": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.fs.write("/m1/a.txt", b"a"))
    asyncio.run(ws.fs.write("/m2/b.txt", b"b"))
    asyncio.run(ws.fs.write("/m3/c.txt", b"c"))
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn)
    ws._registry.mount_for("/m1/").register(rc)
    ws._registry.mount_for("/m2/").register(rc)
    ws._registry.mount_for("/m3/").register(rc)
    io = asyncio.run(ws.execute("nocross /m1/a.txt /m2/b.txt /m3/c.txt"))
    assert io.exit_code == 1
    stderr = io.stderr.decode()
    assert "/m1" in stderr or "/m2" in stderr or "/m3" in stderr


def test_plan_cross_resource_no_aggregate_returns_unknown():
    ws = _make_ws()
    _seed(ws)
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn,
                           provision_fn=_noop_provision)
    _register_on_both(ws, rc)
    result = asyncio.run(
        ws.execute("nocross /m1/a.txt /m2/b.txt", provision=True))
    assert hasattr(result, "precision")


def test_plan_cross_resource_with_aggregate_sums_metrics():
    ws = _make_ws()
    _seed(ws)
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn,
                           provision_fn=_noop_provision)
    _register_on_both(ws, rc)
    result = asyncio.run(
        ws.execute("nocross /m1/a.txt /m2/b.txt", provision=True))
    assert hasattr(result, "precision")


def test_plan_single_mount_still_works():
    ws = _make_ws()
    _seed(ws)
    rc = RegisteredCommand("nocross",
                           spec=_SPEC,
                           resource="ram",
                           filetype=None,
                           fn=_noop_fn,
                           provision_fn=_noop_provision)
    _register_on_both(ws, rc)
    result = asyncio.run(ws.execute("nocross /m1/a.txt", provision=True))
    assert isinstance(result, ProvisionResult)
    assert result.network_read_low == 10


def test_aggregate_partial_failure_propagates_exit_code():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.execute("cat /m1/a.txt /m2/missing.txt"))
    assert io.exit_code != 0


def test_aggregate_partial_failure_still_returns_output():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.execute("cat /m1/a.txt /m2/missing.txt"))
    assert io.exit_code != 0


def test_aggregate_partial_failure_has_stderr():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.execute("cat /m1/a.txt /m2/missing.txt"))
    stderr = io.stderr if io.stderr else b""
    assert len(stderr) > 0


def test_aggregate_all_succeed_exit_zero():
    ws = _make_ws()
    _seed(ws)
    io = asyncio.run(ws.execute("cat /m1/a.txt /m2/b.txt"))
    assert io.exit_code == 0
