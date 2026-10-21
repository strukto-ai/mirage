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

import pytest
import pytest_asyncio

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import command
from mirage.commands.spec.types import CommandSpec
from mirage.config import _build_runtime_entries
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy import (
    CommandExplanation,
    Deny,
    Policy,
    Route,
    ShellExplanation,
)
from mirage.policy.types import RouteContext
from mirage.runtime.base import Runtime
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python import LocalRuntime, MontyRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.resolver import MountResolver
from mirage.runtime.table import catch_all
from mirage.runtime.types import Program, RunResult
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.utils.abort import MirageAbortError


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
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=["monty", "workspace"]
    )
    try:
        io = await ws.shell("python3 -c 'print(6 * 7)'")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"42\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_instance_entry_gets_dispatch_attached():
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[MontyRuntime()]
    )
    try:
        await ws.shell("echo -n hello > /greet.txt")
        io = await ws.shell("python3 -c \"print(open('/greet.txt').read())\"")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"hello\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_instance_entry_runs_on_that_runtime():
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[LocalRuntime()]
    )
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

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"ran-alpha\n", stderr=None, exit_code=0)


class BetaRuntime(PythonRuntime):
    name = "beta"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"ran-beta\n", stderr=None, exit_code=0)


@pytest_asyncio.fixture
async def runtime_arg_ws():
    workspace = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
    )
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_runtime_arg_rebinds_captured_stage(runtime_arg_ws):
    io = await runtime_arg_ws.shell("python3 -c 'x'", runtime="beta")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_a_nested_line_leaves_its_callers_route(runtime_arg_ws):
    @command("nested", vfs="ram", spec=CommandSpec())
    async def nested(accessor, paths, texts, opts):
        await runtime_arg_ws.shell("echo inner")
        return b"", IOResult()

    mount = runtime_arg_ws._registry.mount_for("/")
    for registered in nested._registered_commands:
        mount.register(registered)
    io = await runtime_arg_ws.shell("nested; python3 -c 'x'", runtime="beta")
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
    workspace = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "beta" if "big" in ctx.line else None,
    )
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_a_route_moves_a_line_between_capturers(routed_ws):
    io = await routed_ws.shell("python3 -c 'small'")
    assert await materialize(io.stdout) == b"ran-alpha\n"
    io = await routed_ws.shell("python3 -c 'big job'")
    assert await materialize(io.stdout) == b"ran-beta\n"


@pytest.mark.asyncio
async def test_runtime_arg_beats_the_route(routed_ws):
    io = await routed_ws.shell("python3 -c 'big job'", runtime="alpha")
    assert await materialize(io.stdout) == b"ran-alpha\n"


@pytest.mark.asyncio
async def test_vfs_explicit_captures_restrict_the_workspace():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), WorkspaceRuntime(captures=("echo",))],
    )
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
    entries = _build_runtime_entries(
        [{"name": "workspace", "captures": ["grep", "cat"]}]
    )
    assert isinstance(entries[0], WorkspaceRuntime)
    assert entries[0].captures == ("grep", "cat")


@pytest.mark.asyncio
async def test_empty_captures_serve_nothing():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), WorkspaceRuntime(captures=())],
    )
    try:
        io = await ws.shell("ls /")
        assert io.exit_code == 126
        io = await ws.shell("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_vfs_explicit_captures_restrict_under_routing():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), WorkspaceRuntime(captures=("echo",))],
        route_policy=lambda ctx: None,
    )
    try:
        io = await ws.shell("echo routed-ok")
        assert await materialize(io.stdout) == b"routed-ok\n"
        io = await ws.shell("ls /")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_global_route_names_the_runtime():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "beta" if "heavy" in ctx.line else None,
    )
    try:
        io = await ws.shell("python3 -c 'heavy'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.shell("python3 -c 'light'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


class NoPython(Policy):
    async def pre_execute(self, ctx: RouteContext) -> Deny | None:
        names = [c.command for c in ctx.commands]
        return Deny("python3 is blocked") if "python3" in names else None


@pytest.mark.asyncio
async def test_policy_deny_folds_into_the_line_result():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), "workspace"],
        policies=[NoPython()],
    )
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
        return None

    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), "workspace"],
        route_policy=deny_all,
    )
    try:
        io = await ws.shell("echo (")
        assert io.exit_code == 2
        assert b"syntax error" in io.stderr
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_coded_route_policy_places_beside_a_policys_deny():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "beta",
        policies=[NoSecrets()],
    )
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


class HeavyOnBeta(Policy):
    async def pre_execute(self, ctx: RouteContext) -> Route | None:
        return Route("beta") if "heavy" in ctx.line else None


class NoSecrets(Policy):
    async def pre_execute(self, ctx: RouteContext) -> Deny | None:
        return Deny("secrets stay put") if "secret" in ctx.line else None


def _runtimes(said: ShellExplanation) -> list[str]:
    """The runtime each top-level command of an explained line would
    run on.

    Args:
        said (ShellExplanation): the explained line.
    """
    return [
        node.runtime
        for node in said.node.children
        if isinstance(node, CommandExplanation)
    ]


@pytest.mark.asyncio
async def test_a_coded_policy_places_the_line():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        policies=[HeavyOnBeta()],
    )
    try:
        io = await ws.shell("python3 -c 'heavy'")
        assert await materialize(io.stdout) == b"ran-beta\n"
        io = await ws.shell("python3 -c 'light'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
        # The caller's runtime argument is its own placement.
        io = await ws.shell("python3 -c 'heavy'", runtime="alpha")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_placement_deny_outranks_a_route():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "beta",
        policies=[NoSecrets()],
    )
    try:
        io = await ws.shell("python3 -c 'secret'")
        assert (io.exit_code, io.stderr) == (
            126,
            b"python3: Permission denied\n",
        )
        assert io.refusal is not None
        assert (io.refusal.reason, io.refusal.policy) == (
            "secrets stay put",
            "NoSecrets",
        )
        # A deny holds whoever placed the line, the caller included.
        io = await ws.shell("python3 -c 'secret'", runtime="beta")
        assert io.exit_code == 126
        io = await ws.shell("python3 -c 'x'")
        assert await materialize(io.stdout) == b"ran-beta\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_two_placements_that_disagree_refuse_the_line():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "alpha",
        policies=[HeavyOnBeta()],
    )
    try:
        io = await ws.shell("python3 -c 'heavy'")
        assert io.exit_code == 126
        assert io.refusal is not None
        assert io.refusal.reason == (
            "policies place the line on different runtimes: "
            "PlacementPolicy on alpha, HeavyOnBeta on beta"
        )
        io = await ws.shell("python3 -c 'light'")
        assert await materialize(io.stdout) == b"ran-alpha\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admission_comes_before_placement():
    seen: list[str] = []

    def away(ctx):
        seen.append(ctx.line)
        return None

    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), "workspace"],
        route_policy=away,
    )
    try:
        ws.create_session(
            "agent",
            profile={
                "commands": {
                    "deny": [{"reason": "no deletes", "commands": ["rm"]}]
                }
            },
        )
        io = await ws.shell("rm /x", session_id="agent")
        assert (io.exit_code, io.stderr) == (126, b"rm: Permission denied\n")
        assert io.refusal is not None
        assert io.refusal.reason == "no deletes"
        assert seen == []
        io = await ws.shell("echo ok", session_id="agent")
        assert io.exit_code == 0
        assert seen == ["echo ok"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_names_the_policy_that_placed_the_line():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "beta" if "heavy" in ctx.line else None,
        policies=[NoSecrets()],
    )
    try:
        heavy = await ws.explain("python3 -c 'heavy'")
        assert heavy.answers == (Route("beta", policy="PlacementPolicy"),)
        assert (_runtimes(heavy), heavy.exit_code) == (["beta"], 0)
        light = await ws.explain("python3 -c 'light'")
        assert (light.answers, _runtimes(light)) == ((), ["alpha"])
        # A placement deny refuses the line in the words the run would
        # print, and places none of it.
        secret = await ws.explain("python3 -c 'secret'; echo x")
        assert secret.answers == (
            Deny("secrets stay put", policy="NoSecrets"),
        )
        assert (secret.exit_code, secret.stderr) == (
            126,
            "python3: Permission denied\n",
        )
        assert _runtimes(secret) == ["", ""]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_nested_eval_inherits_routing():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), BetaRuntime(), "workspace"],
        route_policy=lambda ctx: "beta" if "big" in ctx.line else None,
    )
    try:
        # The typed line routes to beta; the inner eval must not
        # re-route even though the inner line alone would pick alpha.
        io = await ws.shell("echo big $(python3 -c 'x')")
        assert await materialize(io.stdout) == b"big ran-beta\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_add_runtime_appends_and_rebinds():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[AlphaRuntime(), "workspace"],
    )
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


def test_a_runtime_entry_takes_no_script():
    with pytest.raises(TypeError, match="script"):
        _build_runtime_entries([{"name": "local", "script": "guard.py"}])


@pytest.mark.asyncio
async def test_code_string_route_is_rejected():
    with pytest.raises(TypeError, match="a path is the workspace yaml's"):
        Workspace({"/ram": RAMVFS()}, route_policy="route.py")


class LineBox(Runtime, LineExecutorMixin):
    name = "sandbox"
    captures = ("nvidia-smi",)

    def __init__(self) -> None:
        self.lines: list[tuple[str, bytes | None, str]] = []

    async def run_line(self, engine, paths, texts, ctx) -> RunResult:
        line = ctx.flags["c"]
        self.lines.append((line, ctx.stdin, ctx.cwd.virtual))
        return RunResult(
            stdout=b"box:" + line.encode(), stderr=None, exit_code=0
        )


class ReadingBox(LineBox):
    """A whole-line runtime that reads a workspace file for its line."""

    async def run_line(self, engine, paths, texts, ctx) -> RunResult:
        data = await ctx.vfs.read("/ram/f.txt")
        return RunResult(stdout=data, stderr=None, exit_code=0)


@pytest.mark.asyncio
async def test_what_a_runtime_reads_is_in_its_lines_report():
    # A runtime's reads are the line's: they reach the workspace's ledger
    # and the observer's account of the line, as a command's do.
    box = ReadingBox()
    box.captures = ("*",)
    ws = Workspace(
        {"/ram": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        await ws.vfs.write("/ram/f.txt", b"hi\n")
        mark = len(ws.vfs.records)
        io = await ws.shell("anything")
        assert await materialize(io.stdout) == b"hi\n"
        assert [(r.op, r.path) for r in ws.vfs.records[mark:]] == [
            ("read", "/ram/f.txt")
        ]
        logged = await ws.observer.events()
        line = next(
            i for i, e in enumerate(logged) if e.get("command") == "anything"
        )
        before = logged[line - 1]
        assert (before["type"], before["op"], before["path"]) == (
            "op",
            "read",
            "/ram/f.txt",
        )
    finally:
        await ws.close()


class StallingBox(LineBox):
    """A whole-line runtime that reads a workspace file, then never ends."""

    def __init__(self) -> None:
        super().__init__()
        self.read = asyncio.Event()

    async def run_line(self, engine, paths, texts, ctx) -> RunResult:
        await ctx.vfs.read("/ram/f.txt")
        self.read.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


@pytest.mark.asyncio
async def test_what_an_aborted_runtime_read_stays_on_the_books():
    # The runtime finished its read before the line was aborted: the read
    # happened, so it reaches the ledger and the line's record all the same.
    box = StallingBox()
    box.captures = ("*",)
    ws = Workspace(
        {"/ram": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        await ws.vfs.write("/ram/f.txt", b"hi\n")
        mark = len(ws.vfs.records)
        cancel = asyncio.Event()
        running = asyncio.ensure_future(ws.shell("anything", cancel=cancel))
        await box.read.wait()
        cancel.set()
        with pytest.raises(MirageAbortError):
            await running
        assert [(r.op, r.path) for r in ws.vfs.records[mark:]] == [
            ("read", "/ram/f.txt")
        ]
        logged = await ws.observer.events()
        line = next(
            i for i, e in enumerate(logged) if e.get("command") == "anything"
        )
        before = logged[line - 1]
        assert (before["type"], before["op"], before["path"]) == (
            "op",
            "read",
            "/ram/f.txt",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_named_capture_keeps_pipeline_and_redirects_in_mirage():
    box = LineBox()
    ws = Workspace(
        {"/ram": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
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
    box.captures = ("*",)
    ws = Workspace(
        {"/ram": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    io = await ws.shell("ls /ram && echo done", stdin=b"fed")
    assert (await materialize(io.stdout)).startswith(b"box:")
    assert box.lines[0][1] == b"fed"
    await ws.close()


@pytest.mark.asyncio
async def test_a_route_to_the_workspace_keeps_a_line_in_mirage():
    box = LineBox()
    box.captures = ("*",)
    ws = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[box, "workspace"],
        route_policy=lambda ctx: (
            "workspace" if "keep-out" in ctx.line else None
        ),
    )
    taken = await ws.shell("echo captured")
    kept = await ws.shell("echo keep-out")
    assert (await materialize(taken.stdout)).startswith(b"box:")
    assert await materialize(kept.stdout) == b"keep-out\n"
    assert kept.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_runtime_argument_places_the_whole_line():
    box = LineBox()
    box.captures = ("*",)
    ws = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[box, "workspace"],
        route_policy=lambda ctx: "workspace",
    )
    refused = await ws.shell("echo hi")
    forced = await ws.shell("echo hi", runtime="sandbox")
    assert await materialize(refused.stdout) == b"hi\n"
    assert (await materialize(forced.stdout)).startswith(b"box:")
    await ws.close()


@pytest.mark.asyncio
async def test_vfs_entry_is_a_pure_routing_marker():
    # A workspace-resolved line runs on the workspace executor inline; the
    # registry entry is a marker with no line entry point to call.
    ws = Workspace({"/ram": RAMVFS()}, mode=MountMode.EXEC)
    fallback = catch_all(ws._runtimes.entries)
    assert fallback is not None
    assert not isinstance(fallback, LineExecutorMixin)
    result = await ws.shell("echo through-workspace")
    assert await materialize(result.stdout) == b"through-workspace\n"
    await ws.close()


def test_stage_engines_carry_no_line_entry_point():
    assert not isinstance(MontyRuntime(), LineExecutorMixin)
    assert not hasattr(MontyRuntime(), "run_line")


class ResolverProbe(PythonRuntime):
    name = "resolver-probe"
    captures = ("probe-run",)
    resolver: MountResolver | None = None

    def bind(self, binding: WorkspaceBinding) -> None:
        super().bind(binding)
        self.resolver = binding.resolver

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
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
