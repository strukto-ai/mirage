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
from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.python import LocalRuntime, MontyRuntime
from mirage.runtime.table import VFS_ENTRY, VfsEntry


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
    with pytest.raises(ValueError, match="vfs runtime entry takes only"):
        _build_runtime_entries([{"name": "vfs", "home": "/x"}])


class AlphaRuntime(Runtime):
    name = "alpha"
    captures = ("python3", "python")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"ran-alpha\n", stderr=None, exit_code=0)


class BetaRuntime(Runtime):
    name = "beta"
    captures = ("python3", "python")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"ran-beta\n", stderr=None, exit_code=0)


@pytest_asyncio.fixture
async def pin_ws():
    workspace = Workspace({"/": RAMResource()},
                          mode=MountMode.EXEC,
                          runtimes=[AlphaRuntime(),
                                    BetaRuntime(), VFS_ENTRY])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_pin_rebinds_captured_stage(pin_ws):
    io = await pin_ws.execute("python3 -c 'x'", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_pin_only_lasts_the_line(pin_ws):
    await pin_ws.execute("python3 -c 'x'", runtime="beta")
    io = await pin_ws.execute("python3 -c 'x'")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_pin_inherited_by_nested_eval(pin_ws):
    io = await pin_ws.execute("echo $(python3 -c 'x')", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_pin_never_touches_uncaptured_stages(pin_ws):
    io = await pin_ws.execute("echo plain-vfs", runtime="beta")
    assert await materialize(io.stdout) == b"plain-vfs\n"


@pytest.mark.asyncio
async def test_pin_unknown_name_fails_loud(pin_ws):
    with pytest.raises(ValueError, match="unknown runtime pin"):
        await pin_ws.execute("python3 -c 'x'", runtime="nope")


@pytest.mark.asyncio
async def test_pin_vfs_fails_loud(pin_ws):
    with pytest.raises(ValueError, match="not a pinnable runtime"):
        await pin_ws.execute("python3 -c 'x'", runtime=VFS_ENTRY)


@pytest_asyncio.fixture
async def routed_ws():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda ctx: "big" not in ctx.line
    workspace = Workspace({"/": RAMResource()},
                          mode=MountMode.EXEC,
                          runtimes=[alpha, beta, VFS_ENTRY])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_scripts_route_between_capturers(routed_ws):
    io = await routed_ws.execute("python3 -c 'small'")
    assert await materialize(io.stdout) == b"ran-alpha\n"
    io = await routed_ws.execute("python3 -c 'big job'")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_pin_beats_scripts(routed_ws):
    io = await routed_ws.execute("python3 -c 'big job'", runtime="alpha")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_all_capturers_refuse_is_admission_failure():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: False
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, VFS_ENTRY])
    try:
        io = await ws.execute("python3 -c 'x'")
        assert io.exit_code == 126
        err = await materialize(io.stderr)
        assert err == b"mirage: python3: no runtime accepted this line\n"
        io = await ws.execute("echo vfs-still-open")
        assert await materialize(io.stdout) == b"vfs-still-open\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_entry_script_locks_down_lines():
    ws = Workspace(
        {"/": RAMResource()},
        mode=MountMode.EXEC,
        runtimes=[VfsEntry(script=lambda ctx: "/secret" not in ctx.line)])
    try:
        io = await ws.execute("echo ok > /notes.txt && cat /notes.txt")
        assert await materialize(io.stdout) == b"ok\n"
        io = await ws.execute("cat /secret/creds")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_global_route_names_the_runtime():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             BetaRuntime(), VFS_ENTRY],
                   route=lambda ctx: "beta" if "heavy" in ctx.line else None)
    try:
        io = await ws.execute("python3 -c 'heavy'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.execute("python3 -c 'light'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_nested_eval_inherits_routing():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda ctx: "big" not in ctx.line
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, beta, VFS_ENTRY])
    try:
        # The typed line routes to beta; the inner eval must not
        # re-route even though the inner line alone would pick alpha.
        io = await ws.execute("echo big $(python3 -c 'x')")
        assert await materialize(io.stdout) == b"big ran-beta\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_add_runtime_appends_and_rebinds():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(), VFS_ENTRY])
    try:
        ws.add_runtime(BetaRuntime())
        io = await ws.execute("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
        io = await ws.execute("python3 -c 'x'", runtime="beta")
        assert await materialize(io.stdout) == b"ran-beta\n"
        with pytest.raises(ValueError, match="duplicate runtime entry"):
            ws.add_runtime(BetaRuntime())
    finally:
        await ws.close()


def test_config_entry_script_and_route_load():
    entries = _build_runtime_entries([{
        "name": "local",
        "script": "ctx['command'] == 'python3'"
    }, {
        "name": "vfs",
        "script": "True"
    }])
    assert entries[0].script == "ctx['command'] == 'python3'"
    assert isinstance(entries[1], VfsEntry)
    assert entries[1].script == "True"


def test_config_vfs_entry_rejects_non_script_options():
    with pytest.raises(ValueError, match="only a script"):
        _build_runtime_entries([{"name": "vfs", "home": "/x"}])


def test_config_script_path_form_embeds_content(tmp_path):
    script = tmp_path / "route.py"
    script.write_text("ctx['command'] == 'python3'")
    entries = _build_runtime_entries([{
        "name": "local",
        "script": str(script)
    }])
    assert entries[0].script == "ctx['command'] == 'python3'"


def test_config_script_path_form_missing_file_fails_loud(tmp_path):
    with pytest.raises(FileNotFoundError):
        _build_runtime_entries([{
            "name": "local",
            "script": str(tmp_path / "nope.py")
        }])
