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


@pytest.fixture
def registry():
    """Minimal registry with a RAM mount at root."""
    reg = MountRegistry()
    res = RAMResource()
    reg.set_default_mount(res)
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
        None,
    )
    assert io.exit_code != 0
