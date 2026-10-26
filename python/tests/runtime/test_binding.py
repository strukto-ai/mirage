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
import os
import threading
from pathlib import Path

import pytest

from mirage import (
    MountMode,
    PathSpec,
    RunResult,
    Runtime,
    UnsupportedExecutionError,
    Workspace,
)
from mirage.commands.builtin.utils.links import link_view
from mirage.commands.config import Context
from mirage.context import (
    get_current_session,
    get_current_session_for,
    reset_current_session,
    set_current_session,
)
from mirage.context.session_context import awaits_as, calls_as
from mirage.io import IOResult
from mirage.mount.core import MountCore
from mirage.observe.context import RecordingScope, record, start_op
from mirage.policy import Deny, Policy, PolicyDenied
from mirage.runtime.binding import WorkspaceBinding, capture_binding
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.handles import parse_mode
from mirage.runtime.js import QuickJsRuntime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime
from mirage.runtime.resolver import PrefixResolver
from mirage.vfs.ram import RAMVFS
from mirage.workspace.session import SessionState


class Probe(LanguageRuntime):
    name = "probe"
    language = "python"
    captures = ("python3",)
    reach = "workspace"

    def __init__(self):
        super().__init__()
        self.contexts = []
        self.bound = None

    def bind(self, binding):
        super().bind(binding)
        self.bound = binding

    async def interpret(self, engine, program, ctx):
        self.contexts.append(ctx)
        return RunResult(
            stdout=program.code.encode(), stderr=None, exit_code=0
        )


class ShellProbe(Runtime, LineExecutorMixin):
    name = "shell-probe"

    async def run_line(self, engine, paths, texts, ctx):
        return RunResult(
            stdout=(ctx.flags["c"] + ":" + ctx.cwd.virtual).encode()
            + (ctx.stdin or b""),
            stderr=None,
            exit_code=0,
        )


class DenySecret(Policy):
    async def pre_session(self, ctx):
        return Deny("protected") if ctx.key == "SECRET" else None


@pytest.mark.asyncio
async def test_execute_capabilities_and_refusals():
    work = PathSpec.from_str_path("/work")
    code = Context(flags={"c": "hello"})
    shell = Context(flags={"c": "echo hello"}, cwd=work, stdin=b"!")
    language, native = Probe(), ShellProbe()
    assert (language.language, language.reach) == ("python", "workspace")
    assert not isinstance(language, LineExecutorMixin)
    assert isinstance(native, LineExecutorMixin)
    assert not isinstance(native, ProcessExecutorMixin)
    assert language.filesystem == native.filesystem == ()
    assert (await language.execute([], [], code)).stdout == b"hello"
    line = await native.execute([], [], shell, kind="line")
    assert line.stdout == b"echo hello:/work!"
    for runtime, texts, ctx, kind in (
        (language, [], shell, "line"),
        (native, [], code, "code"),
        (native, ["echo", "hello"], Context(cwd=work), "process"),
    ):
        with pytest.raises(UnsupportedExecutionError):
            await runtime.execute([], texts, ctx, kind=kind)


@pytest.mark.asyncio
async def test_callbacks_retain_session_and_gate_after_capture():
    with Workspace(
        {"/data": RAMVFS(), "/secret": RAMVFS()},
        mode=MountMode.EXEC,
        policies=[DenySecret()],
    ) as ws:
        await ws.shell("echo private > /secret/a")
        ws.create_session("agent", profile={"paths": {"hide": ["/secret"]}})
        context = ws.runtime_context("agent")
        other = ws.runtime_context()
        assert context.ctx.session is not None
        assert context.ctx.vfs is not None
        assert (
            "/secret/"
            not in calls_as(context.caller, context.ctx.vfs.mount_prefixes)()
        )
        secret = PathSpec.from_str_path("/secret/a")
        with pytest.raises((FileNotFoundError, PermissionError)):
            await context.ctx.vfs.dispatch("read", secret)
        data, _ = await other.ctx.vfs.dispatch("read", secret)
        assert data == b"private\n"
        await context.ctx.session.set("PUBLIC", "agent")
        assert context.ctx.session.get("PUBLIC") == "agent"
        assert other.ctx.session.get("PUBLIC") is None
        assert "PUBLIC" not in context.ctx.env  # launch environment is a copy
        with pytest.raises(PolicyDenied) as refused:
            await context.ctx.session.set("SECRET", "no")
        assert refused.value.refusal is not None
        assert "protected" in refused.value.refusal.reason
        # A captured caller carries the owner as well as the session.
        assert (
            calls_as(context.caller, get_current_session_for)(
                ws._session_mgr
            ).session_id
            == "agent"
        )
        reads = await asyncio.gather(
            awaits_as(
                context.caller,
                lambda: asyncio.sleep(
                    0, result=context.ctx.session.get("PUBLIC")
                ),
            )(),
            awaits_as(
                other.caller,
                lambda: asyncio.sleep(
                    0, result=other.ctx.session.get("PUBLIC")
                ),
            )(),
        )
        assert reads == ["agent", None]


@pytest.mark.asyncio
async def test_context_keeps_namespace_live_and_matches_native_projection():
    probe = Probe()
    with Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe, "workspace"]
    ) as ws:
        await ws.shell("echo shared > /data/a; chmod 600 /data/a")
        context = ws.runtime_context()
        await ws.shell("ln -s /data/a /data/link")
        links = link_view(context.ctx.vfs)
        assert links is not None
        assert (
            calls_as(context.caller, links.resolve)("/data/link") == "/data/a"
        )
        ws.add_mount("/data/nested", RAMVFS(), mode=MountMode.EXEC)
        assert (
            calls_as(context.caller, probe.bound.resolver.owner_of)(
                "/data/nested/a"
            )
            == "/data/nested/"
        )
        vfs = calls_as(context.caller, RuntimeFiles.of)(
            context.ctx, probe.bound
        )
        mount = MountCore(ws.vfs)
        # Call the sync adapter on a worker to keep its serving loop free.
        guest = await asyncio.to_thread(vfs.read, "/data/link")
        native = await mount.read("/data/link", 100, 0, None)
        assert guest == native == b"shared\n"
        assert (
            await asyncio.to_thread(vfs.stat, "/data/a")
        ).mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_binding_prevents_cross_workspace_reuse():
    runtime = Probe()
    with Workspace({}, runtimes=[runtime, "workspace"]) as first:
        with Workspace({}) as second:
            assert first.runtimes()[0] is runtime
            assert (
                await runtime.execute([], [], Context(flags={"c": "ok"}))
            ).stdout == b"ok"
            with pytest.raises(ValueError, match="another workspace"):
                second.add_runtime(runtime)


@pytest.mark.asyncio
async def test_command_execution_supplies_its_active_workspace_context():
    runtime = Probe()
    with Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
    ) as ws:
        ws.create_session("agent")
        await ws.shell("export PUBLIC=agent; cd /data", session_id="agent")
        result = await ws.shell("python3 -c hello", session_id="agent")
        assert result.stdout == b"hello"
        captured = runtime.contexts[-1]
        assert captured.cwd.virtual == "/data"
        assert (captured.env or {})["PUBLIC"] == "agent"
        assert captured.session.get("PUBLIC") == "agent"
        await ws.shell("python3 -c other")
        assert "PUBLIC" not in (runtime.contexts[-1].env or {})
        assert captured.session.get("PUBLIC") == "agent"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["monty", "quickjs", "wasi"])
async def test_adapters_use_each_execution_context_for_filesystem_callbacks(
    name,
):
    if name == "quickjs":
        if not (
            Path(os.environ.get("MIRAGE_QUICKJS_HOME", "")) / "qjs-wasi.wasm"
        ).is_file():
            pytest.skip("MIRAGE_QUICKJS_HOME does not contain qjs-wasi.wasm")
        runtime = QuickJsRuntime()
    elif name == "wasi":
        if not (
            Path(os.environ.get("MIRAGE_WASI_HOME", "")) / "python.wasm"
        ).is_file():
            pytest.skip("MIRAGE_WASI_HOME does not contain python.wasm")
        runtime = WasiRuntime()
    else:
        pytest.importorskip("pydantic_monty")
        runtime = MontyRuntime()
    expected = ("read", "write", "list", "stat")
    assert runtime.filesystem == (
        (*expected, "glob") if name == "wasi" else expected
    )
    with Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
    ) as ws:
        await ws.shell("echo shared > /data/file; ln -s /data/file /data/link")
        one, two = ws.create_session("one"), ws.create_session("two")
        calls = {"one": [], "two": []}
        binding = ws._runtime_binding
        program_dispatch = binding.dispatch

        async def dispatch(op, path, *args, **kwargs):
            session = get_current_session_for(ws._session_mgr)
            calls[session.session_id].append(f"{op}:{path.virtual}")
            return await program_dispatch(op, path, *args, **kwargs)

        binding.dispatch = dispatch

        async def execute(session):
            set_current_session(session, ws._session_mgr)
            code = (
                "const f = std.open('/data/link', 'r'); "
                "std.out.puts(f.readAsString()); f.close()"
                if runtime.language == "js"
                else "print(open('/data/link').read(), end='')"
            )
            return await runtime.execute([], [], Context(flags={"c": code}))

        results = await asyncio.gather(execute(one), execute(two))
        for result in results:
            assert result.exit_code == 0, result.stderr
            assert result.stdout == b"shared\n"
        for entries in calls.values():
            assert any(
                entry in ("read:/data/link", "read:/data/file")
                for entry in entries
            )


@pytest.mark.asyncio
async def test_process_views_do_not_share_by_profile_or_follow_reused_sessions():
    with Workspace({}, runtimes=[], profiles={"agent": {}}) as ws:
        ws.create_session("one", profile="agent")
        ws.create_session("two", profile="agent")
        one = ws.runtime_context("one").ctx.processes
        two = ws.runtime_context("two").ctx.processes
        release = asyncio.Event()

        async def run():
            await release.wait()
            return 0

        process = ws.processes.start(
            session_id="one",
            command="private work",
            cwd=PathSpec.from_str_path("/"),
            run=run,
        )
        assert one.list() == (process.info,)
        assert two.list() == ()
        await ws.close_session("one")
        ws.create_session("one", profile="agent")
        assert one.list() == ()
        assert ws.runtime_context("one").ctx.processes.list() == ()
        release.set()
        await process.join()


class SessionSpyDispatch:
    """Records the session and emits an op event inside each op."""

    def __init__(self):
        self.sessions = []

    async def __call__(self, op, path, **kwargs):
        self.sessions.append(get_current_session())
        record(op, path.virtual, "ram", 7, start_op())
        return b"payload", None


def vfs_read_on_a_bare_thread(vfs):
    # Monty's tokio workers and wasmtime's run thread carry no Python
    # context, so a bare Thread models them: the op arrives with an
    # empty context and only what the context captured can scope it.
    worker = threading.Thread(target=vfs.read, args=("/data/f.txt",))
    worker.start()
    return asyncio.to_thread(worker.join)


@pytest.mark.asyncio
async def test_a_file_adapter_replays_the_launch_session_and_recorder():
    dispatch = SessionSpyDispatch()
    binding = WorkspaceBinding(dispatch, PrefixResolver(lambda: []))
    sess = SessionState(session_id="agent")
    scope = RecordingScope()
    token = set_current_session(sess)
    try:
        vfs = RuntimeFiles.of(capture_binding(binding).ctx, binding)
    finally:
        reset_current_session(token)
    try:
        await vfs_read_on_a_bare_thread(vfs)
    finally:
        scope.close()
    assert dispatch.sessions == [sess]
    assert [(r.op, r.path) for r in scope.records] == [("read", "/data/f.txt")]


@pytest.mark.asyncio
async def test_context_vfs_of_a_bare_launch_stays_unscoped_and_unrecorded():
    dispatch = SessionSpyDispatch()
    binding = WorkspaceBinding(dispatch, PrefixResolver(lambda: []))
    vfs = RuntimeFiles.of(capture_binding(binding).ctx, binding)
    scope = RecordingScope()
    try:
        await vfs_read_on_a_bare_thread(vfs)
    finally:
        scope.close()
    assert dispatch.sessions == [None]
    assert scope.records == []


@pytest.mark.asyncio
async def test_native_runtime_refused_before_running_with_hidden_files():
    runtime = ShellProbe(captures=["@line"])
    with Workspace(
        {"/data": RAMVFS()}, runtimes=[runtime], mode=MountMode.EXEC
    ) as ws:
        ws.create_session(
            "restricted", profile={"paths": {"hide": ["/data/secret"]}}
        )
        result = await ws.shell("echo should-not-run", session_id="restricted")
        assert result.exit_code == 126
        assert result.stdout == b""
        assert result.stderr == b"shell-probe: Permission denied\n"
        assert result.refusal is not None
        assert result.refusal.reason == (
            "runtime cannot enforce this session's file restrictions"
        )


@pytest.mark.parametrize(
    "hidden,expected",
    [
        (["/data/secret"], ("/data/",)),
        (["/secret", "/data/secret"], ("/", "/data/")),
        (["/data/*"], ("/data/",)),
    ],
)
def test_restrictions_belong_to_the_longest_mount(hidden, expected):
    with Workspace({"/data": RAMVFS()}, runtimes=[]) as ws:
        ws.create_session("agent", profile={"paths": {"hide": hidden}})
        assert ws.runtime_context("agent").restricted_mounts == expected


@pytest.mark.asyncio
async def test_cancelled_runtime_owner_refuses_queued_callbacks_without_backend_write():
    seen = []
    ready = asyncio.get_running_loop().create_future()
    owner = None

    async def dispatch(name, path, **kwargs):
        seen.append(name)
        if name == "read":
            assert owner is not None
            owner.cancel()
            return b"revoked", IOResult()
        return None, IOResult()

    binding = WorkspaceBinding(dispatch, PrefixResolver(lambda: ["/data"]))

    async def run():
        files = RuntimeFiles.of(capture_binding(binding).ctx, binding)
        ready.set_result(files)
        await asyncio.Event().wait()

    owner = asyncio.create_task(run())
    files = await ready
    # A native interpreter queues independent callback tasks. Revocation in
    # the first callback must stop both its return and the next callback.
    control = asyncio.create_task(files._call("read", "/control/deny"))
    write = asyncio.create_task(
        files._call("write", "/data/continued", data=b"bad")
    )
    results = await asyncio.gather(control, write, return_exceptions=True)
    assert all(
        isinstance(result, asyncio.CancelledError) for result in results
    )
    with pytest.raises(asyncio.CancelledError):
        await owner
    assert seen == ["read"]
    # Host-owned adapters are not tied to a guest execution's cancellation.
    manual = RuntimeFiles(dispatch, asyncio.get_running_loop())
    await manual._call("write", "/data/host", data=b"allowed")
    assert seen == ["read", "write"]


@pytest.mark.asyncio
async def test_a_cancelled_run_still_lands_what_its_guest_wrote():
    # A write(2) a killed process made stays in its file, so the close
    # a cancelled run's end makes lands it, past the abort too; a new
    # call the guest makes is refused.
    with Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC) as ws:
        ready = asyncio.get_running_loop().create_future()

        async def run():
            ctx = ws.runtime_context().ctx
            ready.set_result(RuntimeFiles.of(ctx, ws._runtime_binding))
            await asyncio.Event().wait()

        owner = asyncio.create_task(run())
        files = await ready
        fh = await asyncio.to_thread(
            files.open, "/data/out.txt", parse_mode("w")
        )
        await asyncio.to_thread(files.pwrite, fh, 0, b"kept")
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner
        await files.abort()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.to_thread(
                files.open, "/data/late.txt", parse_mode("w")
            )
        await asyncio.to_thread(files.close, fh)
        assert await ws.vfs.read("/data/out.txt") == b"kept"
        assert not await ws.vfs.exists("/data/late.txt")
