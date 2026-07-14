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
import time

import pytest

from mirage.runtime.python import LocalRuntime, PythonRunArgs


def test_local_runs_on_host_interpreter():
    runtime = LocalRuntime()
    result = asyncio.run(runtime.run(PythonRunArgs(code="print(21 * 2)")))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"
    assert result.stderr is None


def test_local_passes_argv():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="import sys; print(sys.argv[1:])",
                          args=["a", "b"])))
    assert result.stdout == b"['a', 'b']\n"


def test_local_env_overlays_host():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="import os; print(os.environ['MY_VAR'])",
                          env={"MY_VAR": "v1"})))
    assert result.stdout == b"v1\n"


def test_local_stdin():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            PythonRunArgs(code="import sys; print(sys.stdin.read().upper())",
                          stdin=b"hello")))
    assert result.stdout == b"HELLO\n"


def test_local_exit_code_and_stderr():
    runtime = LocalRuntime()
    result = asyncio.run(runtime.run(PythonRunArgs(code="1/0")))
    assert result.exit_code == 1
    assert b"ZeroDivisionError" in result.stderr


def test_local_name():
    assert LocalRuntime().name == "local"


@pytest.mark.asyncio
async def test_local_cancellation_kills_subprocess():
    runtime = LocalRuntime()
    task = asyncio.ensure_future(
        runtime.run(PythonRunArgs(code="import time; time.sleep(30)")))
    await asyncio.sleep(0.3)
    start = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - start < 5  # killed, not waited out
