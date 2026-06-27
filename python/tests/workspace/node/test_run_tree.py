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

import pytest

from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.resource.ram import RAMResource
from mirage.shell.job_table import JobTable
from mirage.shell.parse import parse
from mirage.types import MountMode
from mirage.workspace.mount import MountRegistry
from mirage.workspace.node import run_command_tree
from mirage.workspace.session import Session
from mirage.workspace.workspace import Workspace


@pytest.fixture
def registry():
    """Minimal registry with a RAM mount at root."""
    reg = MountRegistry()
    res = RAMResource()
    reg.set_root_mount(res)
    reg.mount("/", res, MountMode.WRITE)
    return reg


async def _dispatch_noop(op, path, **kwargs):
    return None, IOResult()


async def _noop_execute(command, **kwargs):
    return IOResult()


def _session():
    return Session(session_id="test", cwd="/")


@pytest.mark.asyncio
async def test_run_command_tree_materializes_stdout(registry):
    ast = parse("echo hello")
    io, exec_node = await run_command_tree(
        _dispatch_noop,
        registry,
        JobTable(),
        _noop_execute,
        "agent",
        ast,
        _session(),
        None,
        None,
    )
    assert io.exit_code == 0
    assert b"hello" in await materialize(io.stdout)
    assert exec_node is not None


@pytest.mark.asyncio
async def test_run_command_tree_propagates_exit_code(registry):
    ast = parse("false")
    io, _ = await run_command_tree(
        _dispatch_noop,
        registry,
        JobTable(),
        _noop_execute,
        "agent",
        ast,
        _session(),
        None,
        None,
    )
    assert io.exit_code != 0


async def _cross_node(cmd: str):
    # A real two-mount workspace wires dispatch/cache; run_command_tree is the
    # seam returning the recorded ExecutionNode (Workspace.execute drops it).
    ws = Workspace({
        "/a": RAMResource(),
        "/b": RAMResource()
    },
                   mode=MountMode.WRITE)
    await ws.execute("mkdir -p /a/dir")
    await ws.execute("printf 'x\\n' > /a/f.txt")
    io, exec_node = await run_command_tree(ws.dispatch, ws._registry,
                                           ws.job_table, _noop_execute,
                                           "agent", parse(cmd),
                                           Session(session_id="t",
                                                   cwd="/"), None, None)
    return io, exec_node


@pytest.mark.asyncio
async def test_cross_mount_exec_node_records_stderr():
    # cp of a directory without -r across mounts: the cross-mount branch builds
    # the node via _exec_node, so its stderr/exit_code must match io.
    io, exec_node = await _cross_node("cp /a/dir /b/x")
    assert io.exit_code == 1
    assert b"omitting directory" in await materialize(io.stderr)
    assert exec_node.exit_code == 1
    assert b"omitting directory" in (exec_node.stderr or b"")


@pytest.mark.asyncio
async def test_cross_mount_exec_node_success_has_no_stderr():
    io, exec_node = await _cross_node("cp /a/f.txt /b/f.txt")
    assert exec_node.exit_code == 0
    assert not (exec_node.stderr or b"")
