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
import pytest_asyncio

from mirage import MountMode, RAMResource, Workspace
from mirage.config import _build_runtime_entries
from mirage.io.types import materialize
from mirage.runtime.python import LocalRuntime, MontyRuntime
from mirage.runtime.table import VFS_ENTRY


@pytest_asyncio.fixture
async def ws():
    workspace = Workspace({"/": RAMResource()}, mode=MountMode.EXEC)
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_default_world_binds_python3(ws):
    io = await ws.execute("python3 -c 'print(40 + 2)'")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"42\n"


@pytest.mark.asyncio
async def test_explicit_name_entry_binds():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=["monty", VFS_ENTRY])
    try:
        io = await ws.execute("python3 -c 'print(6 * 7)'")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"42\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_instance_entry_gets_dispatch_attached():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[MontyRuntime()])
    try:
        await ws.execute("echo -n hello > /greet.txt")
        io = await ws.execute("python3 -c \"print(open('/greet.txt').read())\""
                              )
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"hello\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_instance_entry_runs_on_that_runtime():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[LocalRuntime()])
    try:
        io = await ws.execute("python3 -c 'import sys; print(sys.platform)'")
        assert io.exit_code == 0
        assert (await materialize(io.stdout)).strip() != b""
    finally:
        await ws.close()


def test_unknown_name_fails_loud():
    with pytest.raises(ValueError, match="unknown runtime"):
        Workspace({"/": RAMResource()}, runtimes=["ghost"])


def test_duplicate_entries_fail_loud():
    with pytest.raises(ValueError, match="duplicate runtime entry"):
        Workspace({"/": RAMResource()},
                  runtimes=[LocalRuntime(), LocalRuntime()])


def test_config_entries_build_instances():
    entries = _build_runtime_entries(["local", {"name": "local"}, "vfs"])
    assert entries[0] == "local"
    assert isinstance(entries[1], LocalRuntime)
    assert entries[2] == VFS_ENTRY


def test_config_entry_needs_a_name():
    with pytest.raises(ValueError, match="non-empty 'name'"):
        _build_runtime_entries([{"home": "/x"}])


def test_config_vfs_entry_takes_no_options():
    with pytest.raises(ValueError, match="vfs runtime entry takes no"):
        _build_runtime_entries([{"name": "vfs", "home": "/x"}])
