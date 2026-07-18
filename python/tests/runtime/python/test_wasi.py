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
from mirage.resource.ram import RAMResource
from mirage.runtime.base import RunArgs
from mirage.runtime.python import WasiRuntime
from mirage.runtime.python.wasi import WASI_HOME_ENV


def _build_dir() -> str | None:
    root = os.environ.get(WASI_HOME_ENV)
    if root and (Path(root) / "python.wasm").is_file():
        return root
    return None


live = pytest.mark.skipif(
    _build_dir() is None,
    reason=f"{WASI_HOME_ENV} does not point at a CPython WASI build")


def test_missing_build_dir_raises_hint(monkeypatch):
    monkeypatch.delenv(WASI_HOME_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match="cpython-wasi-build"):
        WasiRuntime()


def test_dir_without_wasm_raises_hint(tmp_path):
    with pytest.raises(FileNotFoundError, match="no python.wasm"):
        WasiRuntime(home=str(tmp_path))


def test_dir_without_stdlib_raises_hint(tmp_path):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    with pytest.raises(FileNotFoundError, match="no lib/python3"):
        WasiRuntime(home=str(tmp_path))


@live
def test_wasi_runs_full_cpython():
    rt = WasiRuntime()
    code = "class A:\n    x = 41\nprint(A.x + 1)"
    result = asyncio.run(rt.run(RunArgs(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"
    assert result.stderr is None


@live
def test_wasi_argv_stdin_env():
    rt = WasiRuntime()
    code = ("import os, sys\n"
            "print(sys.argv[1:])\n"
            "print(sys.stdin.read().strip().upper())\n"
            "print(os.environ['GREETING'])")
    result = asyncio.run(
        rt.run(
            RunArgs(code=code,
                    args=["a1", "a2"],
                    env={"GREETING": "hi-wasi"},
                    stdin=b"piped\n")))
    assert result.exit_code == 0
    assert result.stdout == b"['a1', 'a2']\nPIPED\nhi-wasi\n"


@live
def test_wasi_exit_code_and_traceback():
    rt = WasiRuntime()
    result = asyncio.run(rt.run(RunArgs(code="import sys; sys.exit(7)")))
    assert result.exit_code == 7
    result = asyncio.run(rt.run(RunArgs(code="1 / 0")))
    assert result.exit_code == 1
    assert b"ZeroDivisionError" in (result.stderr or b"")


@live
def test_wasi_host_fs_and_network_invisible():
    rt = WasiRuntime()
    result = asyncio.run(rt.run(RunArgs(code="open('/etc/passwd')")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in (result.stderr or b"")
    result = asyncio.run(rt.run(
        RunArgs(code="import socket; socket.socket()")))
    assert result.exit_code == 1
    assert b"OSError" in (result.stderr or b"")


@live
@pytest.mark.asyncio
async def test_wasi_python3_command_end_to_end():
    ram = RAMResource()
    ram._store.files["/calc.py"] = (b"import sys\n"
                                    b"print(int(sys.argv[1]) * 6)\n")
    ws = Workspace({"/ram": ram}, mode=MountMode.EXEC, runtimes=["wasi"])
    r = await ws.execute("python3 -c \"print('wasi says', 6 * 7)\"")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "wasi says 42\n"
    # Script files resolve through the workspace before the run, so a
    # mounted script executes even though the code cannot see mounts.
    r2 = await ws.execute("python3 /ram/calc.py 7")
    assert r2.exit_code == 0
    assert (await r2.stdout_str()) == "42\n"
    await ws.close()


@live
@pytest.mark.asyncio
async def test_wasi_cancellation_stops_the_run():
    rt = WasiRuntime()
    hot = "n = 0\nwhile True:\n    n = n + 1"
    task = asyncio.ensure_future(rt.run(RunArgs(code=hot)))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # The epoch bump traps the run; a healthy follow-up run proves the
    # runtime survived and the worker thread was reclaimed.
    result = await rt.run(RunArgs(code="print('alive')"))
    assert result.exit_code == 0
    assert result.stdout == b"alive\n"


@live
def test_wasi_reuses_compiled_module():
    rt = WasiRuntime()
    first = asyncio.run(rt.run(RunArgs(code="print(1)")))
    second = asyncio.run(rt.run(RunArgs(code="print(2)")))
    assert (first.stdout, second.stdout) == (b"1\n", b"2\n")
    root = _build_dir()
    assert root is not None
    assert (Path(root) / "python.cwasm").is_file()


@live
@pytest.mark.asyncio
async def test_wasi_mounts_read_write_listdir():
    # Guest file I/O bridges through the workspace dispatch: reads see
    # shell writes, guest writes land in the mount, listdir lists it.
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=["wasi"])
    await ws.execute("echo hello-mount > /data/in.txt")
    code = ("import os\n"
            "print(open('/data/in.txt').read().strip())\n"
            "open('/data/out.txt', 'w').write('from-wasi\\n')\n"
            "print(sorted(os.listdir('/data')))\n")
    r = await ws.execute(f'python3 -c "{code}"')
    assert r.exit_code == 0
    assert (await r.stdout_str()) == ("hello-mount\n"
                                      "['in.txt', 'out.txt']\n")
    r = await ws.execute("cat /data/out.txt")
    assert (await r.stdout_str()) == "from-wasi\n"
    await ws.close()


@live
@pytest.mark.asyncio
async def test_wasi_root_mount_coexists_with_the_build():
    # Mount prefixes route to the workspace; everything else is served
    # from the build directory, so a root mount and the stdlib coexist.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=["wasi"])
    await ws.execute("echo root-mount > /f.txt")
    code = ("import sys\n"
            "print(open('/f.txt').read().strip())\n"
            "print('stdlib', sys.version_info[0])\n")
    r = await ws.execute(f'python3 -c "{code}"')
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "root-mount\nstdlib 3\n"
    await ws.close()


@live
def test_wasi_without_dispatch_sees_no_mounts():
    rt = WasiRuntime()
    code = "import os; print(os.path.exists('/data'))"
    result = asyncio.run(rt.run(RunArgs(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b"False\n"


@live
def test_wasi_build_directory_is_read_only():
    rt = WasiRuntime()
    code = ("\ntry:\n"
            "    open('/python.wasm', 'w')\n"
            "except PermissionError:\n"
            "    print('denied')\n")
    result = asyncio.run(rt.run(RunArgs(code=code)))
    assert result.exit_code == 0
    assert result.stdout == b"denied\n"


@live
@pytest.mark.asyncio
async def test_wasi_session_narrowing_reaches_the_guest():
    # A session narrowed to read on the mount denies guest writes at
    # open() and still serves reads; the default session is unaffected.
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=["wasi"])
    await ws.execute("echo seeded > /data/f0.txt")
    ws.create_session("narrow", {"/data": "read"})
    code = ("\ntry:\n"
            "    open('/data/f.txt', 'w')\n"
            "except PermissionError:\n"
            "    print('denied')\n")
    r = await ws.execute(f'python3 -c "{code}"', session_id="narrow")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "denied\n"
    r = await ws.execute(
        "python3 -c \"print(open('/data/f0.txt').read().strip())\"",
        session_id="narrow")
    assert (await r.stdout_str()) == "seeded\n"
    r = await ws.execute(f'python3 -c "{code}"')
    assert (await r.stdout_str()) == ""
    await ws.close()
