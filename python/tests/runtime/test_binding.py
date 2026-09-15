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
from dataclasses import replace
from pathlib import Path

import pytest

from mirage import (CodeExecution, MountMode, PathSpec, ProcessExecution,
                    RunResult, Runtime, ShellExecution,
                    UnsupportedExecutionError, Workspace)
from mirage.context import get_current_session_for
from mirage.fuse.core import MountCore
from mirage.policy import Deny, Policy
from mirage.resource.ram import RAMResource
from mirage.runtime.js import QuickJsRuntime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.python.wasi import WasiRuntime
from mirage.runtime.vfs import RuntimeVFS


class Probe(LanguageRuntime):
    name = "probe"
    language = "python"
    captures = ("python3", )
    reach = "vfs"

    def __init__(self):
        super().__init__()
        self.contexts = []

    async def _execute_code(self, request, context):
        if context is not None:
            self.contexts.append(context)
        return await super()._execute_code(request, context)

    async def run(self, args):
        return RunResult(stdout=args.code.encode(), stderr=None, exit_code=0)


class ShellProbe(Runtime, LineExecutorMixin):
    name = "shell-probe"

    async def run_line(self, command, stdin, env, cwd):
        return RunResult(stdout=(command + ":" + cwd).encode() +
                         (stdin or b""),
                         stderr=None,
                         exit_code=0)


class DenySecret(Policy):

    async def pre_session(self, ctx):
        return Deny("protected") if ctx.key == "SECRET" else None


@pytest.mark.asyncio
async def test_execute_capabilities_and_refusals():
    code = CodeExecution(language="python", code="hello")
    shell = ShellExecution(line="echo hello",
                           cwd=PathSpec.from_str_path("/work"),
                           stdin=b"!")
    process = ProcessExecution(argv=("echo", "hello"),
                               cwd=PathSpec.from_str_path("/work"))
    language, native = Probe(), ShellProbe()
    assert language.capabilities.languages == ("python", )
    assert language.capabilities.reach == "vfs"
    assert not language.capabilities.shell
    assert native.capabilities.shell and not native.capabilities.process
    assert language.capabilities.filesystem == ()
    assert native.capabilities.filesystem == ()
    assert (await language.execute(code)).stdout == b"hello"
    assert (await native.execute(shell)).stdout == b"echo hello:/work!"
    for runtime, request in ((language, shell), (native, code),
                             (native, process), (language,
                                                 CodeExecution(language="js",
                                                               code="1"))):
        with pytest.raises(UnsupportedExecutionError):
            await runtime.execute(request)


@pytest.mark.asyncio
async def test_callbacks_retain_session_and_gate_after_capture():
    with Workspace({
            "/data": RAMResource(),
            "/secret": RAMResource()
    },
                   mode=MountMode.EXEC,
                   policies=[DenySecret()]) as ws:
        await ws.execute("echo private > /secret/a")
        ws.create_session("agent", profile={"paths": {"hide": ["/secret"]}})
        context = ws.runtime_context("agent")
        other = ws.runtime_context()
        assert context.session_view is not None
        assert "/secret/" not in context.ns.mounts.visible_descendants("/")
        with pytest.raises((FileNotFoundError, PermissionError)):
            await context.dispatch("read", PathSpec.from_str_path("/secret/a"))
        assert (await other.dispatch(
            "read", PathSpec.from_str_path("/secret/a")))[0] == b"private\n"
        await context.session_view.set("PUBLIC", "agent")
        assert context.session_view.get("PUBLIC") == "agent"
        assert other.session_view.get("PUBLIC") is None
        assert "PUBLIC" not in context.env  # launch environment is a copy
        with pytest.raises(PermissionError, match="protected"):
            await context.session_view.set("SECRET", "no")
        # A captured scope carries the owner as well as the session.
        assert context.scope.call(get_current_session_for,
                                  ws._session_mgr).session_id == "agent"
        reads = await asyncio.gather(
            context.scope.run(lambda: asyncio.sleep(
                0, result=context.session_view.get("PUBLIC"))),
            other.scope.run(lambda: asyncio.sleep(
                0, result=other.session_view.get("PUBLIC"))))
        assert reads == ["agent", None]


@pytest.mark.asyncio
async def test_context_keeps_namespace_live_and_matches_native_projection():
    with Workspace({"/data": RAMResource()}, mode=MountMode.EXEC) as ws:
        await ws.execute("echo shared > /data/a; chmod 600 /data/a")
        context = ws.runtime_context()
        await ws.execute("ln -s /data/a /data/link")
        assert context.ns.links is not None
        assert context.ns.links.resolve("/data/link") == "/data/a"
        ws.add_mount("/data/nested", RAMResource(), mode=MountMode.EXEC)
        assert context.resolver.owner_of("/data/nested/a") == "/data/nested/"
        vfs = RuntimeVFS(context.dispatch, asyncio.get_running_loop(),
                         context.resolver)
        mount = MountCore(ws.fs)
        # Call both sync adapters on a worker to keep their serving loop free.
        guest = await asyncio.to_thread(vfs.read, "/data/link")
        native = await asyncio.to_thread(mount.read, "/data/link", 100, 0,
                                         None)
        assert guest == native == b"shared\n"
        assert (await asyncio.to_thread(vfs.stat,
                                        "/data/a")).mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_binding_prevents_cross_workspace_reuse_and_foreign_context():
    runtime = Probe()
    with Workspace({}, runtimes=[runtime, "vfs"]) as first:
        with Workspace({}) as second:
            request = CodeExecution(language="python", code="ok")
            assert (await
                    runtime.execute(request,
                                    first.runtime_context())).stdout == b"ok"
            with pytest.raises(ValueError, match="another binding"):
                await runtime.execute(request, second.runtime_context())
            with pytest.raises(ValueError, match="another workspace"):
                second.add_runtime(runtime)


@pytest.mark.asyncio
async def test_command_execution_supplies_its_active_workspace_context():
    runtime = Probe()
    with Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[runtime, "vfs"]) as ws:
        ws.create_session("agent")
        await ws.execute("export PUBLIC=agent; cd /data", session_id="agent")
        result = await ws.execute("python3 -c hello", session_id="agent")
        assert result.stdout == b"hello"
        captured = runtime.contexts[-1]
        assert captured.cwd.virtual == "/data"
        assert captured.env["PUBLIC"] == "agent"
        assert captured.session_view.get("PUBLIC") == "agent"
        await ws.execute("python3 -c other")
        assert "PUBLIC" not in runtime.contexts[-1].env
        assert captured.session_view.get("PUBLIC") == "agent"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["monty", "quickjs", "wasi"])
async def test_adapters_use_each_execution_context_for_filesystem_callbacks(
        name):
    if name == "quickjs":
        if not (Path(os.environ.get("MIRAGE_QUICKJS_HOME", "")) /
                "qjs-wasi.wasm").is_file():
            pytest.skip("MIRAGE_QUICKJS_HOME does not contain qjs-wasi.wasm")
        runtime = QuickJsRuntime()
    elif name == "wasi":
        if not (Path(os.environ.get("MIRAGE_WASI_HOME", "")) /
                "python.wasm").is_file():
            pytest.skip("MIRAGE_WASI_HOME does not contain python.wasm")
        runtime = WasiRuntime()
    else:
        pytest.importorskip("pydantic_monty")
        runtime = MontyRuntime()
    expected = ("read", "write", "list", "stat")
    assert runtime.capabilities.filesystem == ((*expected, "glob")
                                               if name == "wasi" else expected)
    with Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[runtime, "vfs"]) as ws:
        await ws.execute(
            "echo shared > /data/file; ln -s /data/file /data/link")
        ws.create_session("one")
        ws.create_session("two")
        calls = [[], []]

        async def execute(session, entries):
            captured = ws.runtime_context(session)

            async def dispatch(op, path, *args, **kwargs):
                entries.append(f"{op}:{path.virtual}")
                return await captured.dispatch(op, path, *args, **kwargs)

            context = replace(captured, dispatch=dispatch)
            code = ("const f = std.open('/data/link', 'r'); "
                    "std.out.puts(f.readAsString()); f.close()"
                    if runtime.language == "js" else
                    "print(open('/data/link').read(), end='')")
            return await runtime.execute(
                CodeExecution(language=runtime.language, code=code), context)

        results = await asyncio.gather(execute("one", calls[0]),
                                       execute("two", calls[1]))
        for result in results:
            assert result.exit_code == 0, result.stderr
            assert result.stdout == b"shared\n"
        for entries in calls:
            assert any(entry in ("read:/data/link", "read:/data/file")
                       for entry in entries)
