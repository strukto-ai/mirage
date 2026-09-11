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
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python import LocalRuntime, MontyRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.resolver import MountResolver
from mirage.runtime.routing import DenyResult, RouteResult
from mirage.runtime.table import VFSRuntime
from mirage.runtime.types import DispatchFn, RunArgs, RunResult, ScriptSource


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
                   runtimes=["monty", "vfs"])
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
    assert entries[2] == "vfs"


def test_config_entry_needs_a_name():
    with pytest.raises(ValueError, match="non-empty 'name'"):
        _build_runtime_entries([{"home": "/x"}])


def test_config_vfs_entry_takes_no_options():
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        _build_runtime_entries([{"name": "vfs", "home": "/x"}])


class AlphaRuntime(PythonRuntime):
    name = "alpha"

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"ran-alpha\n", stderr=None, exit_code=0)


class BetaRuntime(PythonRuntime):
    name = "beta"

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"ran-beta\n", stderr=None, exit_code=0)


@pytest_asyncio.fixture
async def runtime_arg_ws():
    workspace = Workspace({"/": RAMResource()},
                          mode=MountMode.EXEC,
                          runtimes=[AlphaRuntime(),
                                    BetaRuntime(), "vfs"])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_runtime_arg_rebinds_captured_stage(runtime_arg_ws):
    io = await runtime_arg_ws.execute("python3 -c 'x'", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_only_lasts_the_line(runtime_arg_ws):
    await runtime_arg_ws.execute("python3 -c 'x'", runtime="beta")
    io = await runtime_arg_ws.execute("python3 -c 'x'")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_runtime_arg_inherited_by_nested_eval(runtime_arg_ws):
    io = await runtime_arg_ws.execute("echo $(python3 -c 'x')", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_never_touches_uncaptured_stages(runtime_arg_ws):
    io = await runtime_arg_ws.execute("echo plain-vfs", runtime="beta")
    assert await materialize(io.stdout) == b"plain-vfs\n"


@pytest.mark.asyncio
async def test_runtime_arg_unknown_name_fails_loud(runtime_arg_ws):
    with pytest.raises(ValueError, match="unknown runtime:"):
        await runtime_arg_ws.execute("python3 -c 'x'", runtime="nope")


@pytest.mark.asyncio
async def test_runtime_arg_vfs_fails_loud(runtime_arg_ws):
    with pytest.raises(ValueError, match="not a runtime you can select"):
        await runtime_arg_ws.execute("python3 -c 'x'", runtime="vfs")


@pytest_asyncio.fixture
async def routed_ws():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda ctx: "big" not in ctx.line
    workspace = Workspace({"/": RAMResource()},
                          mode=MountMode.EXEC,
                          runtimes=[alpha, beta, "vfs"])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_scripts_route_between_capturers(routed_ws):
    io = await routed_ws.execute("python3 -c 'small'")
    assert await materialize(io.stdout) == b"ran-alpha\n"
    io = await routed_ws.execute("python3 -c 'big job'")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_beats_scripts(routed_ws):
    io = await routed_ws.execute("python3 -c 'big job'", runtime="alpha")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_all_capturers_refuse_is_admission_failure():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: False
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, "vfs"])
    try:
        io = await ws.execute("python3 -c 'x'")
        assert io.exit_code == 126
        err = await materialize(io.stderr)
        assert err == b"python3: no runtime accepted this line\n"
        io = await ws.execute("echo vfs-still-open")
        assert await materialize(io.stdout) == b"vfs-still-open\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_entry_script_locks_down_lines():
    ws = Workspace(
        {"/": RAMResource()},
        mode=MountMode.EXEC,
        runtimes=[VFSRuntime(script=lambda ctx: "/secret" not in ctx.line)])
    try:
        io = await ws.execute("echo ok > /notes.txt && cat /notes.txt")
        assert await materialize(io.stdout) == b"ok\n"
        io = await ws.execute("cat /secret/creds")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_explicit_captures_restrict_the_workspace():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             VFSRuntime(captures=("echo", ))])
    try:
        io = await ws.execute("echo listed")
        assert await materialize(io.stdout) == b"listed\n"
        io = await ws.execute("ls /")
        assert io.exit_code == 126
        err = await materialize(io.stderr)
        assert err == b"ls: no runtime accepted this line\n"
        io = await ws.execute("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


def test_config_vfs_entry_carries_captures():
    entries = _build_runtime_entries([{
        "name": "vfs",
        "captures": ["grep", "cat"]
    }])
    assert isinstance(entries[0], VFSRuntime)
    assert entries[0].captures == ("grep", "cat")


@pytest.mark.asyncio
async def test_empty_captures_serve_nothing():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             VFSRuntime(captures=())])
    try:
        io = await ws.execute("ls /")
        assert io.exit_code == 126
        io = await ws.execute("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_script_sees_its_own_stage_on_pipelines():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: ctx.command == "python3"
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, "vfs"])
    try:
        io = await ws.execute("echo lead | python3 -c 'x'")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_explicit_captures_restrict_under_routing():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: True
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, VFSRuntime(captures=("echo", ))])
    try:
        io = await ws.execute("echo routed-ok")
        assert await materialize(io.stdout) == b"routed-ok\n"
        io = await ws.execute("ls /")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_global_route_names_the_runtime():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             BetaRuntime(), "vfs"],
                   route_policy=lambda ctx: "beta"
                   if "heavy" in ctx.line else None)
    try:
        io = await ws.execute("python3 -c 'heavy'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.execute("python3 -c 'light'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policy_deny_folds_into_the_line_result():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(), "vfs"],
                   route_policy=lambda ctx: {"deny": "python3 is blocked"}
                   if ctx.command == "python3" else None)
    try:
        io = await ws.execute("python3 -c 'x'")
        assert io.exit_code == 126
        assert io.stderr == b"python3: Permission denied\n"
        assert io.refusal is not None
        assert io.refusal.reason == "python3 is blocked"
        io = await ws.execute("echo ok")
        assert await materialize(io.stdout) == b"ok\n"
        assert io.exit_code == 0
        # The denied line is still a typed line: it records like any
        # other command.
        events = await ws.history()
        assert [e["command"] for e in events] == ["python3 -c 'x'", "echo ok"]
        assert events[0]["exit_code"] == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_syntax_error_gates_before_policy():
    calls: list[str] = []

    def deny_all(ctx):
        calls.append(ctx.line)
        return {"deny": "nothing runs"}

    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(), "vfs"],
                   route_policy=deny_all)
    try:
        io = await ws.execute("echo (")
        assert io.exit_code == 2
        assert b"syntax error" in io.stderr
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policy_result_arms_route_and_deny():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             BetaRuntime(), "vfs"],
                   route_policy=lambda ctx: DenyResult("secrets stay put")
                   if "secret" in ctx.line else RouteResult("beta"))
    try:
        io = await ws.execute("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.execute("python3 -c 'secret'")
        assert io.exit_code == 126
        assert io.stderr == b"python3: Permission denied\n"
        assert io.refusal is not None
        assert io.refusal.reason == "secrets stay put"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_nested_eval_inherits_routing():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda ctx: "big" not in ctx.line
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, beta, "vfs"])
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
                   runtimes=[AlphaRuntime(), "vfs"])
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


def test_config_inline_script_is_rejected():
    with pytest.raises(ValueError, match=r"reference a \.py/\.js file"):
        _build_runtime_entries([{
            "name": "local",
            "script": "ctx['command'] == 'python3'"
        }])


def test_config_script_path_form_embeds_content(tmp_path):
    script = tmp_path / "policy.py"
    script.write_text("ctx['command'] == 'python3'")
    entries = _build_runtime_entries([{
        "name": "local",
        "script": str(script)
    }, {
        "name": "vfs",
        "script": str(script)
    }])
    assert entries[0].script == ScriptSource("ctx['command'] == 'python3'")
    assert isinstance(entries[1], VFSRuntime)
    assert entries[1].script == ScriptSource("ctx['command'] == 'python3'")


def test_code_string_script_is_rejected():
    vfs = VFSRuntime()
    vfs.script = "ctx['command'] == 'python3'"
    with pytest.raises(TypeError, match="reference a .py file"):
        Workspace({"/ram": RAMResource()}, runtimes=[vfs])


@pytest.mark.asyncio
async def test_code_string_route_is_rejected():
    with pytest.raises(TypeError, match="reference a .py file"):
        Workspace({"/ram": RAMResource()}, route_policy="'local'")


def test_config_script_path_form_missing_file_fails_loud(tmp_path):
    with pytest.raises(FileNotFoundError):
        _build_runtime_entries([{
            "name": "local",
            "script": str(tmp_path / "nope.py")
        }])


class LineBox(Runtime, LineExecutorMixin):
    name = "sandbox"
    captures = ("nvidia-smi", )

    def __init__(self) -> None:
        self.lines: list[tuple[str, bytes | None, str]] = []

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        self.lines.append((line, stdin, cwd))
        return RunResult(stdout=b"box:" + line.encode(),
                         stderr=None,
                         exit_code=0)


@pytest.mark.asyncio
async def test_whole_line_goes_to_the_capturing_runtime():
    box = LineBox()
    ws = Workspace({"/ram": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    io = await ws.execute("nvidia-smi -L | grep GPU > /out.txt")
    assert await materialize(io.stdout
                             ) == b"box:nvidia-smi -L | grep GPU > /out.txt"
    assert box.lines[0][0] == "nvidia-smi -L | grep GPU > /out.txt"
    await ws.close()


@pytest.mark.asyncio
async def test_star_captures_any_line_and_stdin_arrives():
    box = LineBox()
    box.captures = ("*", )
    ws = Workspace({"/ram": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    io = await ws.execute("ls /ram && echo done", stdin=b"fed")
    assert (await materialize(io.stdout)).startswith(b"box:")
    assert box.lines[0][1] == b"fed"
    await ws.close()


@pytest.mark.asyncio
async def test_refused_line_runtime_falls_to_the_workspace():
    box = LineBox()
    box.captures = ("*", )
    box.script = lambda ctx: "keep-out" not in ctx.line
    ws = Workspace({"/ram": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    taken = await ws.execute("echo captured")
    kept = await ws.execute("echo keep-out")
    assert (await materialize(taken.stdout)).startswith(b"box:")
    assert await materialize(kept.stdout) == b"keep-out\n"
    assert kept.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_runtime_argument_places_the_whole_line():
    box = LineBox()
    box.captures = ("*", )
    box.script = lambda ctx: False
    ws = Workspace({"/ram": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "vfs"])
    refused = await ws.execute("echo hi")
    forced = await ws.execute("echo hi", runtime="sandbox")
    assert await materialize(refused.stdout) == b"hi\n"
    assert (await materialize(forced.stdout)).startswith(b"box:")
    await ws.close()


@pytest.mark.asyncio
async def test_vfs_entry_is_a_pure_routing_marker():
    # A vfs-resolved line runs on the workspace executor inline; the
    # registry entry is a marker with no line door to call.
    ws = Workspace({"/ram": RAMResource()}, mode=MountMode.EXEC)
    vfs = ws._registry.vfs_runtime
    assert vfs is not None
    assert not isinstance(vfs, LineExecutorMixin)
    result = await ws.execute("echo through-vfs")
    assert await materialize(result.stdout) == b"through-vfs\n"
    await ws.close()


def test_stage_engines_carry_no_line_door():
    assert not isinstance(MontyRuntime(), LineExecutorMixin)
    assert not hasattr(MontyRuntime(), "run_line")


class ResolverProbe(PythonRuntime):
    name = "resolver-probe"
    captures = ("probe-run", )
    resolver: MountResolver | None = None

    def attach(self, dispatch: DispatchFn, resolver: MountResolver) -> None:
        self.resolver = resolver

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


@pytest.mark.asyncio
async def test_attach_withholds_the_history_view_from_runtimes():
    # The history view is a shell surface, not a place to put files;
    # announcing it would make a WASI guest preopen /.bash_history.
    probe = ResolverProbe()
    ws = Workspace({"/data": RAMResource()}, runtimes=[probe])
    try:
        assert probe.resolver is not None
        prefixes = probe.resolver.prefixes()
        assert "/data/" in prefixes
        assert not any("bash_history" in p for p in prefixes)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_attach_withholds_the_synthetic_root_anchor():
    # Nobody mounted the anchor; forwarding it would make every
    # runtime claim a resource the embedder never asked for.
    probe = ResolverProbe()
    ws = Workspace({"/data": RAMResource()}, runtimes=[probe])
    try:
        assert probe.resolver is not None
        assert "/" not in probe.resolver.prefixes()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_attach_forwards_an_explicit_root_mount():
    # Withheld for being synthetic, never for being `/`: a runtime
    # that cannot serve the root refuses on its own (pyodide does).
    probe = ResolverProbe()
    ws = Workspace({"/": RAMResource()}, runtimes=[probe])
    try:
        assert probe.resolver is not None
        assert "/" in probe.resolver.prefixes()
    finally:
        await ws.close()
