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

import pytest

from mirage.commands.builtin.general.interpreter import (
    exec_refusal,
    not_bound,
    run_output,
    runtime_version,
)
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import CommandRuntime, Program, RunResult
from mirage.types import PathSpec


class EchoRuntime(LanguageRuntime):
    name = "echo"
    language = "python"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(
            stdout=program.code.encode(), stderr=None, exit_code=0
        )


def spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory="/", resolved=True, vfs_path=path)


def test_exec_gate_reports_126():
    refusal = exec_refusal("python3", None, CommandRuntime(exec_allowed=False))
    assert refusal is not None
    _, io = refusal
    assert io.exit_code == 126
    assert io.stderr == b"python3: root mount '/' is not in EXEC mode\n"


def test_exec_gate_lets_an_allowed_program_run():
    assert exec_refusal("python3", None, CommandRuntime()) is None
    assert exec_refusal("python3", spec("/a.py"), CommandRuntime()) is None


def test_exec_gate_asks_about_the_script_path():
    placement = CommandRuntime(
        exec_allowed=False,
        exec_path_allowed=lambda path: path.startswith("/bin/"),
    )
    assert exec_refusal("python3", spec("/bin/a.py"), placement) is None
    refusal = exec_refusal("python3", spec("/data/a.py"), placement)
    assert refusal is not None
    _, io = refusal
    assert io.exit_code == 126
    assert io.stderr == b"python3: /data/a.py: not in EXEC mode\n"


@pytest.mark.asyncio
async def test_runtime_version_without_a_probe_is_unavailable():
    stdout, io = await runtime_version(EchoRuntime(), None)
    assert stdout is None
    assert io.exit_code == 1
    assert io.stderr == b"echo: version information unavailable\n"


def test_not_bound_reports_recorded_hint():
    """A default entry's build error surfaces as the 127 hint."""
    stdout, io = not_bound("python3", "needs the broken extra")
    assert io.exit_code == 127
    assert io.stderr == b"python3: needs the broken extra\n"


def test_not_bound_refuses_without_hint():
    """No captured runtime means refusal, not a hidden interpreter."""
    stdout, io = not_bound("python3", None)
    assert io.exit_code == 127
    assert io.stderr == b"python3: command not found\n"


def test_run_output_is_the_one_result_mapping():
    stdout, io = run_output(
        RunResult(stdout=b"out", stderr=b"err", exit_code=3)
    )
    assert stdout == b"out"
    assert io.exit_code == 3
    assert io.stderr == b"err"


def test_run_output_empty_stdout_becomes_no_stream():
    stdout, io = run_output(RunResult(stdout=b"", stderr=None, exit_code=0))
    assert stdout is None
    assert io.exit_code == 0
    assert io.stderr is None
