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

from mirage import RAMVFS, MountMode, Workspace
from mirage.config import _build_runtime_entries
from mirage.io.types import materialize
from mirage.runtime.base import Runtime
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python import LocalRuntime, MontyRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.resolver import MountResolver
from mirage.runtime.routing import DenyResult, RouteResult
from mirage.runtime.table import WorkspaceRuntime
from mirage.runtime.types import RunArgs, RunResult, ScriptSource


@pytest_asyncio.fixture
async def ws():
    workspace = Workspace({"/": RAMVFS()}, mode=MountMode.EXEC)
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_default_world_binds_python3(ws):
    io = await ws.shell("python3 -c 'print(40 + 2)'")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"42\n"


@pytest.mark.asyncio
async def test_explicit_name_entry_binds():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=["monty", "workspace"])
    try:
        io = await ws.shell("python3 -c 'print(6 * 7)'")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"42\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_instance_entry_gets_dispatch_attached():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[MontyRuntime()])
    try:
        await ws.shell("echo -n hello > /greet.txt")
        io = await ws.shell("python3 -c \"print(open('/greet.txt').read())\"")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"hello\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_instance_entry_runs_on_that_runtime():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[LocalRuntime()])
    try:
        io = await ws.shell("python3 -c 'import sys; print(sys.platform)'")
        assert io.exit_code == 0
        assert (await materialize(io.stdout)).strip() != b""
    finally:
        await ws.close()


def test_unknown_name_fails_loud():
    with pytest.raises(ValueError, match="unknown runtime"):
        Workspace({"/": RAMVFS()}, runtimes=["ghost"])


def test_duplicate_entries_fail_loud():
    with pytest.raises(ValueError, match="duplicate runtime entry"):
        Workspace({"/": RAMVFS()}, runtimes=[LocalRuntime(), LocalRuntime()])


def test_config_entries_build_instances():
    entries = _build_runtime_entries(["local", {"name": "local"}, "workspace"])
    assert entries[0] == "local"
    assert isinstance(entries[1], LocalRuntime)
    assert entries[2] == "workspace"


def test_config_entry_needs_a_name():
    with pytest.raises(ValueError, match="non-empty 'name'"):
        _build_runtime_entries([{"home": "/x"}])


def test_config_vfs_entry_takes_no_options():
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        _build_runtime_entries([{"name": "workspace", "home": "/x"}])


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
    workspace = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_runtime_arg_rebinds_captured_stage(runtime_arg_ws):
    io = await runtime_arg_ws.shell("python3 -c 'x'", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_only_lasts_the_line(runtime_arg_ws):
    await runtime_arg_ws.shell("python3 -c 'x'", runtime="beta")
    io = await runtime_arg_ws.shell("python3 -c 'x'")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_runtime_arg_inherited_by_nested_eval(runtime_arg_ws):
    io = await runtime_arg_ws.shell("echo $(python3 -c 'x')", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_never_touches_uncaptured_stages(runtime_arg_ws):
    io = await runtime_arg_ws.shell("echo plain-workspace", runtime="beta")
    assert await materialize(io.stdout) == b"plain-workspace\n"


@pytest.mark.asyncio
async def test_runtime_arg_unknown_name_fails_loud(runtime_arg_ws):
    with pytest.raises(ValueError, match="unknown runtime:"):
        await runtime_arg_ws.shell("python3 -c 'x'", runtime="nope")


@pytest.mark.asyncio
async def test_runtime_arg_vfs_fails_loud(runtime_arg_ws):
    with pytest.raises(ValueError, match="not a runtime you can select"):
        await runtime_arg_ws.shell("python3 -c 'x'", runtime="workspace")


@pytest_asyncio.fixture
async def routed_ws():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda ctx: "big" not in ctx.line
    workspace = Workspace({"/": RAMVFS()},
                          mode=MountMode.EXEC,
                          runtimes=[alpha, beta, "workspace"])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_scripts_route_between_capturers(routed_ws):
    io = await routed_ws.shell("python3 -c 'small'")
    assert await materialize(io.stdout) == b"ran-alpha\n"
    io = await routed_ws.shell("python3 -c 'big job'")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_beats_scripts(routed_ws):
    io = await routed_ws.shell("python3 -c 'big job'", runtime="alpha")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_all_capturers_refuse_is_admission_failure():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: False
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, "workspace"])
    try:
        io = await ws.shell("python3 -c 'x'")
        assert io.exit_code == 126
        err = await materialize(io.stderr)
        assert err == b"python3: no runtime accepted this line\n"
        io = await ws.shell("echo workspace-still-open")
        assert await materialize(io.stdout) == b"workspace-still-open\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_entry_script_locks_down_lines():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[
            WorkspaceRuntime(script=lambda ctx: "/secret" not in ctx.line)
        ])
    try:
        io = await ws.shell("echo ok > /notes.txt && cat /notes.txt")
        assert await materialize(io.stdout) == b"ok\n"
        io = await ws.shell("cat /secret/creds")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_explicit_captures_restrict_the_workspace():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(),
                  WorkspaceRuntime(captures=("echo", ))])
    try:
        io = await ws.shell("echo listed")
        assert await materialize(io.stdout) == b"listed\n"
        io = await ws.shell("ls /")
        assert io.exit_code == 126
        err = await materialize(io.stderr)
        assert err == b"ls: no runtime accepted this line\n"
        io = await ws.shell("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


def test_config_vfs_entry_carries_captures():
    entries = _build_runtime_entries([{
        "name": "workspace",
        "captures": ["grep", "cat"]
    }])
    assert isinstance(entries[0], WorkspaceRuntime)
    assert entries[0].captures == ("grep", "cat")


@pytest.mark.asyncio
async def test_empty_captures_serve_nothing():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             WorkspaceRuntime(captures=())])
    try:
        io = await ws.shell("ls /")
        assert io.exit_code == 126
        io = await ws.shell("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_script_sees_its_own_stage_on_pipelines():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: ctx.command == "python3"
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, "workspace"])
    try:
        io = await ws.shell("echo lead | python3 -c 'x'")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_explicit_captures_restrict_under_routing():
    alpha = AlphaRuntime()
    alpha.script = lambda ctx: True
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha,
                             WorkspaceRuntime(captures=("echo", ))])
    try:
        io = await ws.shell("echo routed-ok")
        assert await materialize(io.stdout) == b"routed-ok\n"
        io = await ws.shell("ls /")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_global_route_names_the_runtime():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             BetaRuntime(), "workspace"],
                   route_policy=lambda ctx: "beta"
                   if "heavy" in ctx.line else None)
    try:
        io = await ws.shell("python3 -c 'heavy'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.shell("python3 -c 'light'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policy_deny_folds_into_the_line_result():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(), "workspace"],
                   route_policy=lambda ctx: {"deny": "python3 is blocked"}
                   if ctx.command == "python3" else None)
    try:
        io = await ws.shell("python3 -c 'x'")
        assert io.exit_code == 126
        assert io.stderr == b"python3: Permission denied\n"
        assert io.refusal is not None
        assert io.refusal.reason == "python3 is blocked"
        io = await ws.shell("echo ok")
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

    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(), "workspace"],
                   route_policy=deny_all)
    try:
        io = await ws.shell("echo (")
        assert io.exit_code == 2
        assert b"syntax error" in io.stderr
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policy_result_arms_route_and_deny():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(),
                             BetaRuntime(), "workspace"],
                   route_policy=lambda ctx: DenyResult("secrets stay put")
                   if "secret" in ctx.line else RouteResult("beta"))
    try:
        io = await ws.shell("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.shell("python3 -c 'secret'")
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
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[alpha, beta, "workspace"])
    try:
        # The typed line routes to beta; the inner eval must not
        # re-route even though the inner line alone would pick alpha.
        io = await ws.shell("echo big $(python3 -c 'x')")
        assert await materialize(io.stdout) == b"big ran-beta\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_add_runtime_appends_and_rebinds():
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[AlphaRuntime(), "workspace"])
    try:
        ws.add_runtime(BetaRuntime())
        io = await ws.shell("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
        io = await ws.shell("python3 -c 'x'", runtime="beta")
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
        "name": "workspace",
        "script": str(script)
    }])
    assert entries[0].script == ScriptSource("ctx['command'] == 'python3'")
    assert isinstance(entries[1], WorkspaceRuntime)
    assert entries[1].script == ScriptSource("ctx['command'] == 'python3'")


def test_code_string_script_is_rejected():
    fallback = WorkspaceRuntime()
    fallback.script = "ctx['command'] == 'python3'"
    with pytest.raises(TypeError, match="reference a .py file"):
        Workspace({"/ram": RAMVFS()}, runtimes=[fallback])


@pytest.mark.asyncio
async def test_code_string_route_is_rejected():
    with pytest.raises(TypeError, match="reference a .py file"):
        Workspace({"/ram": RAMVFS()}, route_policy="'local'")


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
async def test_named_capture_keeps_pipeline_and_redirects_in_mirage():
    box = LineBox()
    ws = Workspace({"/ram": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "workspace"])
    try:
        io = await ws.shell("nvidia-smi -L | grep box > /ram/out.txt")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b""
        assert box.lines[0][0] == "nvidia-smi -L"
        saved = await ws.shell("cat /ram/out.txt")
        assert await materialize(saved.stdout) == b"box:nvidia-smi -L\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_star_captures_any_line_and_stdin_arrives():
    box = LineBox()
    box.captures = ("*", )
    ws = Workspace({"/ram": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "workspace"])
    io = await ws.shell("ls /ram && echo done", stdin=b"fed")
    assert (await materialize(io.stdout)).startswith(b"box:")
    assert box.lines[0][1] == b"fed"
    await ws.close()


@pytest.mark.asyncio
async def test_refused_line_runtime_falls_to_the_workspace():
    box = LineBox()
    box.captures = ("*", )
    box.script = lambda ctx: "keep-out" not in ctx.line
    ws = Workspace({"/ram": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "workspace"])
    taken = await ws.shell("echo captured")
    kept = await ws.shell("echo keep-out")
    assert (await materialize(taken.stdout)).startswith(b"box:")
    assert await materialize(kept.stdout) == b"keep-out\n"
    assert kept.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_runtime_argument_places_the_whole_line():
    box = LineBox()
    box.captures = ("*", )
    box.script = lambda ctx: False
    ws = Workspace({"/ram": RAMVFS()},
                   mode=MountMode.EXEC,
                   runtimes=[box, "workspace"])
    refused = await ws.shell("echo hi")
    forced = await ws.shell("echo hi", runtime="sandbox")
    assert await materialize(refused.stdout) == b"hi\n"
    assert (await materialize(forced.stdout)).startswith(b"box:")
    await ws.close()


@pytest.mark.asyncio
async def test_vfs_entry_is_a_pure_routing_marker():
    # A workspace-resolved line runs on the workspace executor inline; the
    # registry entry is a marker with no line door to call.
    ws = Workspace({"/ram": RAMVFS()}, mode=MountMode.EXEC)
    fallback = ws._registry.workspace_runtime
    assert fallback is not None
    assert not isinstance(fallback, LineExecutorMixin)
    result = await ws.shell("echo through-workspace")
    assert await materialize(result.stdout) == b"through-workspace\n"
    await ws.close()


def test_stage_engines_carry_no_line_door():
    assert not isinstance(MontyRuntime(), LineExecutorMixin)
    assert not hasattr(MontyRuntime(), "run_line")


class ResolverProbe(PythonRuntime):
    name = "resolver-probe"
    captures = ("probe-run", )
    resolver: MountResolver | None = None

    def bind(self, binding: WorkspaceBinding) -> None:
        super().bind(binding)
        self.resolver = binding.resolver

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


@pytest.mark.asyncio
async def test_binding_withholds_the_history_view_from_runtimes():
    # The history view is a shell surface, not a place to put files;
    # announcing it would make a WASI guest preopen /.bash_history.
    probe = ResolverProbe()
    ws = Workspace({"/data": RAMVFS()}, runtimes=[probe])
    try:
        assert probe.resolver is not None
        prefixes = probe.resolver.prefixes()
        assert "/data/" in prefixes
        assert not any("bash_history" in p for p in prefixes)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_binding_withholds_the_synthetic_root_anchor():
    # Nobody mounted the anchor; forwarding it would make every
    # runtime claim a VFS the embedder never asked for.
    probe = ResolverProbe()
    ws = Workspace({"/data": RAMVFS()}, runtimes=[probe])
    try:
        assert probe.resolver is not None
        assert "/" not in probe.resolver.prefixes()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_binding_forwards_an_explicit_root_mount():
    # Withheld for being synthetic, never for being `/`: a runtime
    # that cannot serve the root refuses on its own (pyodide does).
    probe = ResolverProbe()
    ws = Workspace({"/": RAMVFS()}, runtimes=[probe])
    try:
        assert probe.resolver is not None
        assert "/" in probe.resolver.prefixes()
    finally:
        await ws.close()
