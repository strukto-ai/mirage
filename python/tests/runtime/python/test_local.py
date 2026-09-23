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
import json
import sys
import time
from pathlib import Path

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.runtime.python import LocalRuntime
from mirage.runtime.types import RunArgs


@pytest.mark.asyncio
@pytest.mark.parametrize('operation, expected', [
    ('list', 'seed.txt\nsub\n'),
    ('stat', 'file 5 32768\ndir 16384\nmissing\n'),
    ('glob', 'seed.txt\nsub/inner.txt\n'),
])
async def test_filesystem_operations(tmp_path, operation, expected):
    (tmp_path / 'seed.txt').write_text('seed\n')
    (tmp_path / 'sub').mkdir()
    (tmp_path / 'sub' / 'inner.txt').write_text('inner\n')
    fixture = (Path(__file__).resolve().parents[4] / 'integ' / 'fixtures' /
               'runtime' / 'fs' / 'py' / f'{operation}.py')
    runtime = LocalRuntime()
    try:
        result = await runtime.run(
            RunArgs(code=fixture.read_text(),
                    env={'MIRAGE_TEST_ROOT': str(tmp_path)}))
        assert result.exit_code == 0, result.stderr
        assert result.stdout.decode() == expected
        assert result.stderr is None
    finally:
        await runtime.close()


def test_local_runs_on_host_interpreter():
    runtime = LocalRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="print(21 * 2)")))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"
    assert result.stderr is None


def test_local_passes_argv():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import sys; print(sys.argv[1:])", args=["a", "b"])))
    assert result.stdout == b"['a', 'b']\n"


def test_local_env_overlays_host():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import os; print(os.environ['MY_VAR'])",
                    env={"MY_VAR": "v1"})))
    assert result.stdout == b"v1\n"


def test_local_stdin():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import sys; print(sys.stdin.read().upper())",
                    stdin=b"hello")))
    assert result.stdout == b"HELLO\n"


@pytest.mark.parametrize("stdin", [None, b"", b"x" * 300_000],
                         ids=["absent", "empty", "large"])
def test_script_cli_stdin_is_not_embedded_in_process_argv(stdin):
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code=("from __future__ import annotations\n"
                          "import sys\nprint(argv)\n"
                          "print(stdin is None, len(stdin or b''), "
                          "sys.stdin.buffer.read() == (stdin or b''))"),
                    prog="pager",
                    args=["one"],
                    script_cli=True,
                    stdin=stdin)))
    assert result.exit_code == 0
    assert result.stdout == (
        f"['pager', 'one']\n{stdin is None} {len(stdin or b'')} True\n"
    ).encode()


def test_local_exit_code_and_stderr():
    runtime = LocalRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="1/0")))
    assert result.exit_code == 1
    assert b"ZeroDivisionError" in result.stderr


def test_local_name():
    assert LocalRuntime().name == "local"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode",
                         [MountMode.READ, MountMode.WRITE, MountMode.EXEC])
async def test_version_process_uses_only_host_environment(
        tmp_path, monkeypatch, mode):
    monkeypatch.setenv("MIRAGE_TEST_VERSION_ENV", "host")
    session = {
        "LD_PRELOAD": str(tmp_path / "session.so"),
        "LD_LIBRARY_PATH": str(tmp_path),
        "DYLD_INSERT_LIBRARIES": str(tmp_path / "session.dylib"),
        "DYLD_LIBRARY_PATH": str(tmp_path),
        "PATH": str(tmp_path),
        "MIRAGE_TEST_VERSION_ENV": "session",
    }
    probe = tmp_path / "python-probe"
    probe.write_text(
        f"#!{sys.executable}\nimport json, os\n"
        f"keys = {list(session)!r}\n"
        "print(json.dumps({k: os.environ.get(k) for k in keys}))\n")
    probe.chmod(0o755)
    runtime = LocalRuntime(config={"home": str(probe)})
    baseline = await runtime.version({})
    expected = json.loads(baseline.stdout)
    assert expected["MIRAGE_TEST_VERSION_ENV"] == "host"
    ws = Workspace({"/": RAMVFS()}, mode=mode, runtimes=[runtime, "workspace"])
    try:
        for line in ["python --version", "python3 -V", "python -VV"]:
            io = await ws.shell(line, env=session)
            assert io.exit_code == 0
            assert json.loads(await io.stdout_str()) == expected
            assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_read_only_version_does_not_run_startup_code(tmp_path):
    marker = tmp_path / "startup-ran"
    (tmp_path / "sitecustomize.py"
     ).write_text(f"open({str(marker)!r}, 'w').write('ran')\n")
    env = {"PYTHONPATH": str(tmp_path)}
    runtime = LocalRuntime(config={"home": sys.executable})
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.READ,
                   runtimes=[runtime, "workspace"])
    try:
        for line in ["python --version", "python3 -V", "python -VV"]:
            io = await ws.shell(line, env=env)
            assert io.exit_code == 0
            assert await io.stdout_str(
            ) == f"Python {sys.version.split()[0]}\n"
            assert await io.stderr_str() == ""
            assert not marker.exists()
        refused = await ws.shell("python -c 'pass'", env=env)
        assert refused.exit_code == 126
        assert not marker.exists()
        control = await runtime.run(RunArgs(code="pass", env=env))
        assert control.exit_code == 0
        assert marker.read_text() == "ran"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_local_cancellation_kills_subprocess():
    runtime = LocalRuntime()
    task = asyncio.ensure_future(
        runtime.run(RunArgs(code="import time; time.sleep(30)")))
    await asyncio.sleep(0.3)
    start = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - start < 5  # killed, not waited out


def test_reach_is_process():
    # The subprocess sees the host filesystem and network: doors the
    # workspace gate never sees, so a world holding this runtime may
    # not claim a sandbox.
    assert LocalRuntime.reach == "process"
