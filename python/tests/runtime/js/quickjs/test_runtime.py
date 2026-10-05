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
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.io.types import materialize
from mirage.runtime.errors import EvalError
from mirage.runtime.js import QuickJsRuntime
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV
from mirage.runtime.types import RunArgs
from mirage.runtime.wasm import WasmView
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS


def _home_dir() -> str | None:
    root = os.environ.get(QUICKJS_HOME_ENV)
    if root and (Path(root) / "qjs-wasi.wasm").is_file():
        return root
    return None


live = pytest.mark.skipif(
    _home_dir() is None,
    reason=f"{QUICKJS_HOME_ENV} does not point at a qjs-wasi.wasm build",
)


def test_missing_home_raises_hint(monkeypatch):
    monkeypatch.delenv(QUICKJS_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="quickjs-ng"):
        QuickJsRuntime()


def test_dir_without_wasm_raises_hint(tmp_path):
    with pytest.raises(FileNotFoundError, match="no qjs-wasi.wasm"):
        QuickJsRuntime(config={"home": str(tmp_path)})


class _ArgvSpy:
    def __init__(self) -> None:
        self.argv: list[str] = []

    async def run(self, *, argv, stdin, env, fs):
        self.argv = list(argv)
        return b"", b"", 0


def _spied_runtime() -> QuickJsRuntime:
    # __init__ demands a real qjs-wasi.wasm on disk and argv assembly is
    # the only thing under test, so the engine is stubbed out. These run
    # everywhere; the @live tests below need the build.
    rt = object.__new__(QuickJsRuntime)
    rt._binding = None
    rt._execution = _ArgvSpy()
    return rt


@pytest.mark.asyncio
async def test_program_args_ride_behind_the_end_of_options_marker():
    # Unlike CPython's -c, qjs's -e does not end option parsing, so a
    # program argument spelling a qjs switch gets read as one: without
    # the `--`, `node - -e prog` ran prog (the second -e wins) and
    # `node - -m` silently flipped module mode. The TS host sets
    # scriptArgs as a global and never had the hole.
    rt = _spied_runtime()
    await rt.run(RunArgs(code="CODE", args=["-e", "PROG", "-m"]))
    assert rt._execution.argv == [
        "qjs",
        "--std",
        "-e",
        "CODE",
        "--",
        "-e",
        "PROG",
        "-m",
    ]


@pytest.mark.asyncio
async def test_named_program_still_takes_the_first_arg_slot():
    rt = _spied_runtime()
    await rt.run(RunArgs(code="CODE", prog="tool", args=["-m"]))
    assert rt._execution.argv == [
        "qjs",
        "--std",
        "-e",
        "CODE",
        "--",
        "tool",
        "-m",
    ]


@pytest.mark.asyncio
async def test_module_mode_is_still_the_interpreters_own_switch():
    rt = _spied_runtime()
    await rt.run(RunArgs(code="CODE", flags={"module": True}))
    assert rt._execution.argv == ["qjs", "--std", "-m", "-e", "CODE", "--"]


@live
@pytest.mark.asyncio
async def test_version_commands_report_the_quickjs_engine():
    runtime = QuickJsRuntime()
    raw, _, code = await runtime._execution.run(
        argv=["qjs", "--version"], stdin=None, env=[], fs=WasmView()
    )
    assert code == 0
    ws = Workspace({"/": RAMVFS()}, runtimes=[runtime, "workspace"])
    try:
        for line in ["js --version", "node --version", "js -v", "node -v"]:
            io = await ws.shell(line)
            assert io.exit_code == 0
            assert await materialize(io.stdout) == (
                b"JavaScript (quickjs-ng " + raw.strip() + b")\n"
            )
            assert await materialize(io.stderr) == b""
    finally:
        await ws.close()


@live
def test_quickjs_runs_modern_js():
    rt = QuickJsRuntime()
    code = (
        "const f = (n) => n * 6 + 1; "
        "console.log(JSON.stringify([...'ab'].map((s, i) => s + i)), f(6))"
    )
    result = asyncio.run(rt.run(RunArgs(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b'["a0","b1"] 37\n'
    assert result.stderr is None


@live
def test_quickjs_argv_stdin_module():
    rt = QuickJsRuntime()
    result = asyncio.run(
        rt.run(
            RunArgs(
                code="console.log(scriptArgs.join('/'))", args=["a1", "a2"]
            )
        )
    )
    assert result.stdout == b"a1/a2\n"
    # std.in reads piped stdin (the std/os globals are exposed).
    result = asyncio.run(
        rt.run(
            RunArgs(
                code="console.log(std.in.readAsString().trim().toUpperCase())",
                stdin=b"piped\n",
            )
        )
    )
    assert result.stdout == b"PIPED\n"
    # module mode enables top-level await.
    result = asyncio.run(
        rt.run(
            RunArgs(
                code="const x = await Promise.resolve(41); console.log(x + 1)",
                flags={"module": True},
            )
        )
    )
    assert result.stdout == b"42\n"


@live
def test_quickjs_exit_code_and_error():
    rt = QuickJsRuntime()
    result = asyncio.run(rt.run(RunArgs(code="std.exit(7)")))
    assert result.exit_code == 7
    result = asyncio.run(rt.run(RunArgs(code="this is not js")))
    assert result.exit_code == 1
    assert b"SyntaxError" in (result.stderr or b"")


@live
@pytest.mark.parametrize(
    "path", ["/etc/passwd", "/data/in.txt"], ids=["host-file", "mount-path"]
)
def test_quickjs_without_dispatch_opens_nothing(path):
    # No dispatch: the sandbox filesystem is empty, so neither a host
    # path nor a mount path opens (std.open returns null rather than a
    # handle).
    rt = QuickJsRuntime()
    code = f"console.log(std.open('{path}', 'r') === null)"
    result = asyncio.run(rt.run(RunArgs(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b"true\n"


@live
@pytest.mark.asyncio
async def test_quickjs_node_command_end_to_end():
    ram = RAMVFS()
    ram._store.files["/calc.mjs"] = (
        b"export const k = 6;\nconsole.log(Number(scriptArgs[0]) * k)\n"
    )
    ws = Workspace({"/ram": ram}, mode=MountMode.EXEC, runtimes=["quickjs"])
    r = await ws.shell("node -e \"console.log('js says', 6 * 7)\"")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "js says 42\n"
    # A mounted .mjs resolves through the workspace and runs in module mode.
    r2 = await ws.shell("node /ram/calc.mjs 7")
    assert r2.exit_code == 0
    assert (await r2.stdout_str()) == "42\n"
    await ws.close()


@live
@pytest.mark.asyncio
async def test_quickjs_cancellation_stops_the_run():
    rt = QuickJsRuntime()
    task = asyncio.ensure_future(rt.run(RunArgs(code="for (;;) {}")))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await rt.run(RunArgs(code="console.log('alive')"))
    assert result.exit_code == 0
    assert result.stdout == b"alive\n"


@live
def test_quickjs_reuses_compiled_module():
    rt = QuickJsRuntime()
    first = asyncio.run(rt.run(RunArgs(code="console.log(1)")))
    second = asyncio.run(rt.run(RunArgs(code="console.log(2)")))
    assert (first.stdout, second.stdout) == (b"1\n", b"2\n")
    root = _home_dir()
    assert root is not None
    assert (Path(root) / "qjs-wasi.cwasm").is_file()


@live
@pytest.mark.asyncio
async def test_quickjs_session_narrowing_reaches_the_guest():
    # A session narrowed to read denies guest writes at open() and no
    # file materializes in the mount.
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=["quickjs"]
    )
    ws.create_session("narrow", {"/data": "read"})
    r = await ws.shell(
        "js -e \"try { std.open('/data/g.txt', 'w').puts('x');"
        " console.log('WROTE') } catch (e) { console.log('denied') }\"",
        session_id="narrow",
    )
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "denied\n"
    r = await ws.shell("cat /data/g.txt", session_id="narrow")
    assert r.exit_code == 1
    await ws.close()


@live
@pytest.mark.asyncio
async def test_eval_returns_the_completion_value():
    rt = QuickJsRuntime()
    result = await rt.eval(
        "ctx.command === 'node' ? {deny: 'no'} : null",
        inputs={"ctx": {"command": "node"}},
    )
    assert result.value == {"deny": "no"}
    result = await rt.eval("console.log('side'); 1 + 41")
    assert result.value == 42
    assert result.stdout == b"side\n"


@live
@pytest.mark.asyncio
async def test_eval_failures_raise_eval_error():
    rt = QuickJsRuntime()
    with pytest.raises(EvalError) as syn:
        await rt.eval("def broken(")
    assert syn.value.syntax
    with pytest.raises(EvalError):
        await rt.eval("throw new Error('boom')")
    with pytest.raises(EvalError, match="one-shot"):
        await rt.eval("1", session="s1")


def test_reach_is_vfs():
    assert QuickJsRuntime.reach == "workspace"


@live
@pytest.mark.asyncio
async def test_cwd_inherits_context_and_eval_is_isolated():
    runtime = QuickJsRuntime()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
    )
    try:
        assert (
            await ws.shell(
                "mkdir /data/sub; echo child > /data/sub/item; cd /data"
            )
        ).exit_code == 0
        args = RunArgs(code="console.log(os.getcwd()[0])")
        assert (await runtime.run(args)).stdout == b"/data\n"
        explicit = await runtime.run(
            RunArgs(code=args.code, cwd=PathSpec.from_str_path("/data/sub"))
        )
        assert explicit.stdout == b"/data/sub\n"
        assert (
            await runtime.eval(
                "os.chdir('sub'); std.open('item', 'r').readAsString()"
            )
        ).value == "child\n"
        assert (await runtime.eval("os.getcwd()[0]")).value == "/data"
        assert (await runtime.eval("os", inputs={"os": 42})).value == 42
        bad = await runtime.run(
            RunArgs(
                code="console.log('must not run')",
                cwd=PathSpec.from_str_path("/missing"),
            )
        )
        assert bad.exit_code == 1
        assert bad.stdout == b""
        assert b"cannot change directory" in bad.stderr
        assert (await runtime.eval("os.getcwd()[0]")).value == "/data"
    finally:
        await ws.close()
