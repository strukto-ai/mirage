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
from mirage.runtime.python import WasiRuntime
from mirage.runtime.python.wasi.config import WasiConfig
from mirage.runtime.python.wasi.runtime import WASI_HOME_ENV, _stdlib_mount
from mirage.runtime.types import Program, RunResult
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS


def _build_dir() -> str | None:
    root = os.environ.get(WASI_HOME_ENV)
    if root and (Path(root) / "python.wasm").is_file():
        return root
    return None


live = pytest.mark.skipif(
    _build_dir() is None,
    reason=f"{WASI_HOME_ENV} does not point at a CPython WASI build",
)


def _args(code: str, env: dict[str, str] | None = None, **fields):
    return Program(code=code, **fields), env


async def _run(rt: WasiRuntime, program: Program, **fields) -> RunResult:
    return await rt.interpret(await rt.engine(), program, Context(**fields))


async def _execute(runtime: WasiRuntime, code: str, **fields) -> RunResult:
    return await runtime.execute([], [], Context(flags={"c": code}, **fields))


def test_missing_build_dir_raises_hint(monkeypatch):
    monkeypatch.delenv(WASI_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="cpython-wasi-build"):
        WasiRuntime()


def test_dir_without_wasm_raises_hint(tmp_path):
    with pytest.raises(FileNotFoundError, match="no python.wasm"):
        WasiRuntime(config={"home": str(tmp_path)})


def test_dir_without_stdlib_raises_hint(tmp_path):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    with pytest.raises(FileNotFoundError, match="no lib/python3"):
        WasiRuntime(config={"home": str(tmp_path)})


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/lib", "/lib/python3.12"])
async def test_a_mount_over_the_stdlib_refuses_the_run(tmp_path, prefix):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    (tmp_path / "lib" / "python3.12").mkdir(parents=True)
    runtime = WasiRuntime(config={"home": str(tmp_path)})
    ws = Workspace({prefix: RAMVFS()}, mode=MountMode.EXEC, runtimes=[runtime])
    try:
        r = await ws.shell("python3 -c 'print(1)'")
        assert r.exit_code == 126
        assert (await r.stdout_str()) == ""
        assert (await r.stderr_str()) == (
            f"mirage: the wasi runtime cannot run with a mount at "
            f"'{prefix}', which hides the interpreter's standard library "
            "at /lib\n"
        )
    finally:
        await ws.close()


@pytest.mark.parametrize(
    "prefixes, hiding",
    [
        (["/lib"], "/lib"),
        (
            ["/data", "/lib/python3.12/site-packages"],
            "/lib/python3.12/site-packages",
        ),
        (["/lib/app", "/library"], None),
    ],
)
def test_only_a_mount_over_the_stdlib_is_refused(prefixes, hiding):
    assert _stdlib_mount(prefixes) == hiding


@live
@pytest.mark.asyncio
async def test_a_mount_beside_the_stdlib_runs():
    ws = Workspace(
        {"/lib/app": RAMVFS()}, mode=MountMode.EXEC, runtimes=["wasi"]
    )
    try:
        r = await ws.shell("python3 -c 'print(1)'")
        assert r.exit_code == 0
        assert (await r.stdout_str()) == "1\n"
    finally:
        await ws.close()


# A program's whole answer: what it prints, its exit code, and a phrase
# its stderr carries (None: nothing on stderr). The host's files and
# network stay invisible, a run with no dispatch sees no mounts, and the
# interpreter's build directory refuses writes.
@live
@pytest.mark.parametrize(
    ("args", "exit_code", "stdout", "stderr"),
    [
        pytest.param(
            _args(code="class A:\n    x = 41\nprint(A.x + 1)"),
            0,
            b"42\n",
            None,
            id="full-cpython",
        ),
        pytest.param(
            _args(
                code="import os, sys\n"
                "print(sys.argv[1:])\n"
                "print(sys.stdin.read().strip().upper())\n"
                "print(os.environ['GREETING'])",
                args=["a1", "a2"],
                env={"GREETING": "hi-wasi"},
                stdin=b"piped\n",
            ),
            0,
            b"['a1', 'a2']\nPIPED\nhi-wasi\n",
            None,
            id="argv-stdin-env",
        ),
        pytest.param(
            _args(code="import sys; sys.exit(7)"),
            7,
            b"",
            None,
            id="exit-code",
        ),
        pytest.param(
            _args(code="1 / 0"), 1, b"", b"ZeroDivisionError", id="traceback"
        ),
        pytest.param(
            _args(code="open('/etc/passwd')"),
            1,
            b"",
            b"FileNotFoundError",
            id="host-files-invisible",
        ),
        pytest.param(
            _args(code="import socket; socket.socket()"),
            1,
            b"",
            b"OSError",
            id="network-invisible",
        ),
        pytest.param(
            _args(code="import os; print(os.path.exists('/data'))"),
            0,
            b"False\n",
            None,
            id="no-mounts-without-dispatch",
        ),
        pytest.param(
            _args(
                code="\ntry:\n"
                "    open('/python.wasm', 'w')\n"
                "except PermissionError:\n"
                "    print('denied')\n"
            ),
            0,
            b"denied\n",
            None,
            id="build-directory-read-only",
        ),
    ],
)
def test_wasi_runs_a_program(args, exit_code, stdout, stderr):
    program, env = args
    result = asyncio.run(_run(WasiRuntime(), program, env=env))
    assert (result.exit_code, result.stdout) == (exit_code, stdout)
    if stderr is None:
        assert result.stderr is None
    else:
        assert stderr in result.stderr


@live
@pytest.mark.asyncio
async def test_wasi_python3_command_end_to_end():
    ram = RAMVFS()
    ram._store.files["/calc.py"] = b"import sys\nprint(int(sys.argv[1]) * 6)\n"
    ws = Workspace({"/ram": ram}, mode=MountMode.EXEC, runtimes=["wasi"])
    r = await ws.shell("python3 -c \"print('wasi says', 6 * 7)\"")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "wasi says 42\n"
    # Script files resolve through the workspace before the run, so a
    # mounted script executes even though the code cannot see mounts.
    r2 = await ws.shell("python3 /ram/calc.py 7")
    assert r2.exit_code == 0
    assert (await r2.stdout_str()) == "42\n"
    await ws.close()


@live
@pytest.mark.asyncio
async def test_wasi_cancellation_stops_the_run():
    rt = WasiRuntime()
    hot = "n = 0\nwhile True:\n    n = n + 1"
    task = asyncio.ensure_future(_run(rt, Program(code=hot)))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # The epoch bump traps the run; a healthy follow-up run proves the
    # runtime survived and the worker thread was reclaimed.
    result = await _run(rt, Program(code="print('alive')"))
    assert result.exit_code == 0
    assert result.stdout == b"alive\n"


@live
def test_wasi_reuses_compiled_module():
    rt = WasiRuntime()
    first = asyncio.run(_run(rt, Program(code="print(1)")))
    second = asyncio.run(_run(rt, Program(code="print(2)")))
    assert (first.stdout, second.stdout) == (b"1\n", b"2\n")
    root = _build_dir()
    assert root is not None
    assert (Path(root) / "python.cwasm").is_file()


@live
@pytest.mark.asyncio
async def test_wasi_session_narrowing_reaches_the_guest():
    # A session narrowed to read on the mount denies guest writes at
    # open() and still serves reads; the default session is unaffected.
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=["wasi"])
    await ws.shell("echo seeded > /data/f0.txt")
    ws.create_session("narrow", {"/data": "read"})
    code = (
        "import errno\ntry:\n"
        "    open('/data/f.txt', 'w')\n"
        "except OSError as e:\n"
        "    print('denied', errno.errorcode[e.errno])\n"
    )
    r = await ws.shell(f'python3 -c "{code}"', session_id="narrow")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "denied EROFS\n"
    r = await ws.shell(
        "python3 -c \"print(open('/data/f0.txt').read().strip())\"",
        session_id="narrow",
    )
    assert (await r.stdout_str()) == "seeded\n"
    r = await ws.shell(f'python3 -c "{code}"')
    assert (await r.stdout_str()) == ""
    await ws.close()


def test_reach_is_vfs():
    assert WasiRuntime.reach == "workspace"


def test_max_memory_must_be_a_size():
    with pytest.raises(ValueError, match="max_memory must be a size"):
        WasiConfig(max_memory="lots")


@live
@pytest.mark.asyncio
async def test_max_memory_caps_a_run():
    rt = WasiRuntime(config={"max_memory": "64M"})
    big = await _run(rt, Program(code="x = bytearray(100 * 1024 * 1024)"))
    assert big.exit_code == 1
    assert big.stderr is not None and b"MemoryError" in big.stderr
    small = await _run(rt, Program(code="print(1)"))
    assert (small.exit_code, small.stdout) == (0, b"1\n")


@live
@pytest.mark.asyncio
async def test_max_memory_below_the_interpreters_start_says_so():
    rt = WasiRuntime(config={"max_memory": "8M"})
    result = await _run(rt, Program(code="print(1)"))
    assert result.exit_code == 1
    assert result.stderr is not None
    assert b"cannot start within max_memory" in result.stderr


@live
@pytest.mark.asyncio
async def test_a_bound_run_takes_the_callers_cwd_not_the_sessions():
    runtime = WasiRuntime()
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
        code = "import os; print(os.getcwd())"
        assert (await _execute(runtime, code)).stdout == b"/\n"
        explicit = await _execute(
            runtime,
            "print(open('item').read(), end='')",
            cwd=PathSpec.from_str_path("/data/sub"),
        )
        assert explicit.stdout == b"child\n"
        bad = await _execute(
            runtime,
            "print('must not run')",
            cwd=PathSpec.from_str_path("/missing"),
        )
        assert bad.exit_code == 1
        assert bad.stdout == b""
        assert b"FileNotFoundError" in bad.stderr
        assert (await _execute(runtime, code)).stdout == b"/\n"
    finally:
        await ws.close()
