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

from mirage.resource.ram import RAMResource
from mirage.runtime.python import MontyRuntime, PythonRunArgs
from mirage.types import MountMode
from mirage.workspace import Workspace


class FakeDispatch:
    """Async dispatch stub backed by a dict of virtual files."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.writes: list[tuple[str, bytes]] = []
        self.unlinked: list[str] = []

    async def __call__(self, op, path, **kwargs):
        virtual = path.virtual
        if op == "read":
            if virtual not in self.files:
                raise FileNotFoundError(virtual)
            return self.files[virtual], None
        if op == "readdir":
            prefix = virtual.rstrip("/") + "/"
            names = set()
            for p in self.files:
                if p.startswith(prefix):
                    names.add(p[len(prefix):].split("/")[0])
            if not names and virtual.rstrip("/") not in ("", "/"):
                raise FileNotFoundError(virtual)
            return sorted(names), None
        if op == "write":
            data = kwargs["data"]
            self.files[virtual] = data
            self.writes.append((virtual, data))
            return None, None
        if op == "unlink":
            self.files.pop(virtual, None)
            self.unlinked.append(virtual)
            return None, None
        raise ValueError(f"unexpected op {op}")


def test_monty_runs_sandboxed_print():
    runtime = MontyRuntime()
    result = asyncio.run(runtime.run(PythonRunArgs(code="print(21 * 2)")))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"
    assert result.stderr is None


def test_monty_syntax_error():
    runtime = MontyRuntime()
    result = asyncio.run(runtime.run(PythonRunArgs(code="def broken(")))
    assert result.exit_code == 1
    assert b"SyntaxError" in result.stderr


def test_monty_runtime_error_keeps_stdout():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(PythonRunArgs(code="print('before')\n1/0")))
    assert result.exit_code == 1
    assert result.stdout == b"before\n"
    assert b"ZeroDivisionError" in result.stderr


def test_monty_argv_global():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(PythonRunArgs(code="print(argv[1:])", args=["a", "b"])))
    assert result.exit_code == 0
    assert result.stdout == b"['a', 'b']\n"


def test_monty_env_isolated_to_run_env():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(
                code="import os; print(os.environ.get('MY_VAR', 'unset'))",
                env={"MY_VAR": "v1"})))
    assert result.stdout == b"v1\n"


def test_monty_host_filesystem_invisible():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(PythonRunArgs(code="print(open('/etc/passwd').read())")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_reads_virtual_file_via_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"virtual"})
    runtime = MontyRuntime(dispatch)
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="print(open('/s3/a.txt').read().upper())")))
    assert result.exit_code == 0
    assert result.stdout == b"VIRTUAL\n"


def test_monty_missing_virtual_file():
    dispatch = FakeDispatch({})
    runtime = MontyRuntime(dispatch)
    result = asyncio.run(
        runtime.run(PythonRunArgs(code="open('/s3/missing.txt')")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_write_flushes_through_dispatch():
    dispatch = FakeDispatch({"/s3/seed.txt": b"x"})
    runtime = MontyRuntime(dispatch)
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="from pathlib import Path\n"
                          "Path('/s3/out.txt').write_text('data')")))
    assert result.exit_code == 0
    assert ("/s3/out.txt", b"data") in dispatch.writes
    assert dispatch.files["/s3/out.txt"] == b"data"


def test_monty_append_flushes_full_content():
    dispatch = FakeDispatch({"/s3/log.txt": b"a"})
    runtime = MontyRuntime(dispatch)
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="with open('/s3/log.txt', 'a') as f:\n"
                          "    f.write('b')")))
    assert result.exit_code == 0
    assert dispatch.files["/s3/log.txt"] == b"ab"


def test_monty_iterdir_lists_virtual_dir():
    dispatch = FakeDispatch({"/s3/a.txt": b"1", "/s3/b.txt": b"2"})
    runtime = MontyRuntime(dispatch)
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="from pathlib import Path\n"
                          "print(sorted(str(p) "
                          "for p in Path('/s3').iterdir()))")))
    assert result.exit_code == 0
    assert result.stdout == b"['/s3/a.txt', '/s3/b.txt']\n"


def test_monty_unlink_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"1"})
    runtime = MontyRuntime(dispatch)
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="from pathlib import Path\n"
                          "Path('/s3/a.txt').unlink()")))
    assert result.exit_code == 0
    assert dispatch.unlinked == ["/s3/a.txt"]


def test_monty_name():
    assert MontyRuntime().name == "monty"


@pytest.mark.asyncio
async def test_monty_runs_off_loop_and_cancellation_halts():
    rt = MontyRuntime()
    hot = "n = 0\nwhile True:\n    n = n + 1"
    task = asyncio.ensure_future(rt.run(PythonRunArgs(code=hot)))
    ticks = 0
    for _ in range(6):
        await asyncio.sleep(0.05)
        ticks += 1
    assert ticks == 6  # the loop stayed free while the interpreter ran
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await rt.run(PythonRunArgs(code="print(6 * 7)"))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"


def test_monty_missing_extra_raises(monkeypatch):
    import mirage.runtime.python.monty as monty_module
    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        MontyRuntime()


def test_python3_reports_missing_extra(monkeypatch):
    import mirage.runtime.python.monty as monty_module
    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.EXEC)
    io = asyncio.run(ws.execute("python3 -c 'print(1)'"))
    assert io.exit_code == 127
    assert b"monty' extra" in io.stderr


def test_workspace_explicit_monty_fails_loud(monkeypatch):
    import mirage.runtime.python.monty as monty_module
    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        Workspace({"/data": RAMResource()},
                  mode=MountMode.EXEC,
                  python_runtime="monty")
