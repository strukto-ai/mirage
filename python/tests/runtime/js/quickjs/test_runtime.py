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
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.runtime.js import QuickJsRuntime
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV
from mirage.runtime.types import Program, RunResult
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


async def _run(rt: QuickJsRuntime, program: Program, **fields) -> RunResult:
    return await rt.interpret(await rt.engine(), program, Context(**fields))


async def _execute(rt: QuickJsRuntime, code: str, **fields) -> RunResult:
    return await rt.execute([], [], Context(flags={"c": code}, **fields))


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

    async def run(self, *, argv, stdin, env, fs, output=None, errors=None):
        self.argv = list(argv)
        return b"", b"", 0


async def _spied_argv(program: Program, **fields) -> list[str]:
    # __init__ demands a real qjs-wasi.wasm on disk and argv assembly is
    # the only thing under test, so the engine is stubbed out. These run
    # everywhere; the @live tests below need the build.
    rt = object.__new__(QuickJsRuntime)
    rt._binding = None
    spy = _ArgvSpy()
    await rt.interpret(spy, program, Context(**fields))
    return spy.argv


@pytest.mark.asyncio
async def test_program_args_ride_behind_the_end_of_options_marker():
    # Unlike CPython's -c, qjs's -e does not end option parsing, so a
    # program argument spelling a qjs switch gets read as one: without
    # the `--`, `node - -e prog` ran prog (the second -e wins) and
    # `node - -m` silently flipped module mode. The TS host sets
    # scriptArgs as a global and never had the hole.
    argv = await _spied_argv(Program(code="CODE", args=["-e", "PROG", "-m"]))
    assert argv == [
        "qjs",
        "--std",
        "--script",
        "-e",
        "CODE",
        "--",
        "-e",
        "PROG",
        "-m",
    ]


@pytest.mark.asyncio
async def test_named_program_still_takes_the_first_arg_slot():
    argv = await _spied_argv(Program(code="CODE", prog="tool", args=["-m"]))
    assert argv == [
        "qjs",
        "--std",
        "--script",
        "-e",
        "CODE",
        "--",
        "tool",
        "-m",
    ]


@pytest.mark.asyncio
async def test_module_mode_is_still_the_interpreters_own_switch():
    argv = await _spied_argv(Program(code="CODE"), flags={"module": True})
    assert argv == ["qjs", "--std", "-m", "-e", "CODE", "--"]


@live
@pytest.mark.asyncio
async def test_version_commands_report_the_quickjs_engine():
    runtime = QuickJsRuntime()
    raw, _, code = await (await runtime.engine()).run(
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
    result = asyncio.run(_run(rt, Program(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b'["a0","b1"] 37\n'
    assert result.stderr is None


@live
def test_quickjs_argv_stdin_module():
    rt = QuickJsRuntime()
    result = asyncio.run(
        _run(
            rt,
            Program(
                code="console.log(scriptArgs.join('/'))", args=["a1", "a2"]
            ),
        )
    )
    assert result.stdout == b"a1/a2\n"
    # std.in reads piped stdin (the std/os globals are exposed).
    result = asyncio.run(
        _run(
            rt,
            Program(
                code="console.log(std.in.readAsString().trim().toUpperCase())",
                stdin=b"piped\n",
            ),
        )
    )
    assert result.stdout == b"PIPED\n"
    # module mode enables top-level await.
    result = asyncio.run(
        _run(
            rt,
            Program(
                code="const x = await Promise.resolve(41); console.log(x + 1)"
            ),
            flags={"module": True},
        )
    )
    assert result.stdout == b"42\n"


@live
def test_quickjs_exit_code_and_error():
    rt = QuickJsRuntime()
    result = asyncio.run(_run(rt, Program(code="std.exit(7)")))
    assert result.exit_code == 7
    result = asyncio.run(_run(rt, Program(code="this is not js")))
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
    result = asyncio.run(_run(rt, Program(code=code)))
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


# A run cancelled while its sink holds a write waits for that write to
# finish its own cleanup, so neither outlives the run.
@live
@pytest.mark.asyncio
async def test_quickjs_cancelled_run_waits_for_the_write_its_sink_holds():
    entered, cleaned = asyncio.Event(), asyncio.Event()

    async def output(data: bytes) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.sleep(0.1)
            cleaned.set()
            raise

    rt = QuickJsRuntime()
    run = asyncio.ensure_future(
        rt.execute(
            [], [], Context(flags={"c": "console.log(1)"}), output=output
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 30)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run
        assert cleaned.is_set()
    finally:
        await rt.close()


# A program's writes reach its reader as it runs, so one that never ends
# stops once its reader has what it wanted, as SIGPIPE stops it.
@live
@pytest.mark.asyncio
async def test_quickjs_endless_writer_stops_once_its_reader_has_enough():
    ws = Workspace(
        {"/ram": RAMVFS()}, mode=MountMode.EXEC, runtimes=["quickjs"]
    )
    try:
        r = await asyncio.wait_for(
            ws.shell(
                "js -e \"for (;;) console.log('y')\" | head -n 2;"
                ' echo "${PIPESTATUS[@]}"'
            ),
            30,
        )
        assert (await r.stdout_str()) == "y\ny\n141 0\n"
    finally:
        await ws.close()


@live
@pytest.mark.asyncio
async def test_quickjs_cancellation_stops_the_run():
    rt = QuickJsRuntime()
    task = asyncio.ensure_future(_run(rt, Program(code="for (;;) {}")))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await _run(rt, Program(code="console.log('alive')"))
    assert result.exit_code == 0
    assert result.stdout == b"alive\n"


@live
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,code",
    [
        ('timeout 1 node -e "for (;;) {}"', 124),
        ('timeout -s CONT -k 1 1 node -e "for (;;) {}"', 137),
    ],
)
async def test_a_deadline_stops_a_guest_that_never_yields(line, code):
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=["quickjs"]
    )
    try:
        io = await ws.shell(line)
        assert io.exit_code == code
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


class _SlowRAM(RAMVFS):
    async def pwrite(self, path, data, offset):
        await asyncio.sleep(0.6)
        await super().pwrite(path, data, offset)

    async def write(self, path, data, *, atomic=False):
        await asyncio.sleep(0.6)
        await super().write(path, data, atomic=atomic)


@live
@pytest.mark.asyncio
async def test_a_deadline_joins_the_landing_of_what_a_stopped_guest_wrote():
    # The run's end closes the file it left open, which takes longer than
    # a moment: timeout answers once that write has landed.
    ws = Workspace(
        {"/data": _SlowRAM()}, mode=MountMode.EXEC, runtimes=["quickjs"]
    )
    try:
        io = await ws.shell(
            "timeout 1 node -e \"const f = std.open('/data/o', 'w'); "
            "f.puts('kept'); f.flush(); for (;;) {}\"; cat /data/o"
        )
        assert await io.stdout_str() == "kept"
    finally:
        await ws.close()


@live
@pytest.mark.asyncio
async def test_descriptor_and_byte_calls_answer_as_the_shim_mirrors():
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=["quickjs"]
    )
    program = "\n".join(
        [
            "const fd = os.open('/data/z', os.O_RDWR | os.O_CREAT)",
            "const b = new Uint8Array([104, 105]).buffer",
            "console.log(fd, os.write(fd, b, 0, 2),"
            " os.seek(fd, 0n, std.SEEK_SET), os.seek(fd, -1, std.SEEK_SET))",
            "const got = new ArrayBuffer(4)",
            "console.log(os.read(fd, got, 0, 4),"
            " new Uint8Array(got, 0, 2).join(','),"
            " os.close(fd), os.close(fd), os.isatty(fd))",
            "const f = std.open('/data/z', 'r+')",
            "const first = f.getByte()",
            "f.seek(0, std.SEEK_END)",
            "console.log(first, f.putByte(321), f.tell())",
            "f.close()",
            "console.log(std.loadFile('/data/z'))",
        ]
    )
    try:
        await ws.shell("cat > /data/p.js", stdin=program.encode())
        io = await ws.shell("node /data/p.js")
        assert await io.stdout_str() == (
            "4 2 0 -28\n2 104,105 0 -8 false\n104 65 3\nhiA\n"
        )
    finally:
        await ws.close()


@live
def test_quickjs_reuses_compiled_module():
    rt = QuickJsRuntime()
    first = asyncio.run(_run(rt, Program(code="console.log(1)")))
    second = asyncio.run(_run(rt, Program(code="console.log(2)")))
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


def test_reach_is_vfs():
    assert QuickJsRuntime.reach == "workspace"


@live
@pytest.mark.asyncio
async def test_a_bound_run_takes_the_callers_cwd_not_the_sessions():
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
        code = "console.log(os.getcwd()[0])"
        assert (await _execute(runtime, code)).stdout == b"/\n"
        explicit = await _execute(
            runtime, code, cwd=PathSpec.from_str_path("/data/sub")
        )
        assert explicit.stdout == b"/data/sub\n"
        bad = await _execute(
            runtime,
            "console.log('must not run')",
            cwd=PathSpec.from_str_path("/missing"),
        )
        assert bad.exit_code == 1
        assert bad.stdout == b""
        assert b"cannot change directory" in bad.stderr
        assert (await _execute(runtime, code)).stdout == b"/\n"
    finally:
        await ws.close()
