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

from mirage.commands.builtin.general.interpreter import (Source,
                                                         resolve_source,
                                                         run_code, run_output)
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import RunArgs, RunResult
from mirage.types import PathSpec


class EchoRuntime(LanguageRuntime):
    name = "echo"
    language = "python"

    def __init__(self, dispatch=None):
        self.seen: list[RunArgs] = []

    async def run(self, args: RunArgs) -> RunResult:
        self.seen.append(args)
        return RunResult(stdout=args.code.encode(), stderr=None, exit_code=0)


async def fake_dispatch(op, path, *args, **kwargs):
    if path.virtual == "/script.py":
        return b"print('from-script')", None
    raise FileNotFoundError(path.virtual)


def spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory="/",
                    resolved=True,
                    resource_path=path)


@pytest.mark.asyncio
async def test_exec_gate_reports_126():
    error, prepared = await resolve_source("python3", [], (), None, None, None,
                                           None, False)
    assert prepared is None
    assert error is not None
    _, io = error
    assert io.exit_code == 126
    assert b"EXEC mode" in io.stderr


@pytest.mark.asyncio
async def test_payload_wins_and_operands_become_argv():
    error, prepared = await resolve_source("python3", [spec("/a.py")], ("x", ),
                                           "print(1)", None, None, None, True)
    assert error is None
    assert prepared == Source(code="print(1)",
                              args=["/a.py", "x"],
                              stdin=None,
                              script_path=None)


@pytest.mark.asyncio
async def test_script_operand_reads_through_dispatch():
    error, prepared = await resolve_source("python3", [spec("/script.py")],
                                           ("--flag", ), None, None,
                                           fake_dispatch, None, True)
    assert error is None
    assert prepared is not None
    assert prepared.code == "print('from-script')"
    assert prepared.args == ["--flag"]
    assert prepared.script_path is not None


@pytest.mark.asyncio
async def test_missing_script_reports_no_such_file():
    error, prepared = await resolve_source("js", [spec("/nope.js")], (), None,
                                           None, fake_dispatch, None, True)
    assert prepared is None
    assert error is not None
    _, io = error
    assert io.exit_code == 1
    assert b"No such file" in io.stderr


@pytest.mark.asyncio
async def test_no_input_reports_error():
    error, prepared = await resolve_source("python3", [], (), None, None, None,
                                           None, True)
    assert prepared is None
    assert error is not None
    _, io = error
    assert b"no input" in io.stderr


@pytest.mark.asyncio
async def test_run_source_uses_bound_runtime_and_flags():
    runtime = EchoRuntime()
    prepared = Source(code="hi")
    stdout, io = await run_code("js", prepared, {"K": "V"}, {"module": True},
                                runtime, None)
    assert io.exit_code == 0
    assert runtime.seen[0].flags == {"module": True}
    assert runtime.seen[0].env == {"K": "V"}


@pytest.mark.asyncio
async def test_run_source_unbound_reports_recorded_hint():
    """A default entry's build error surfaces as the 127 hint."""
    prepared = Source(code="hi")
    stdout, io = await run_code("python3", prepared, None, {}, None,
                                "needs the broken extra")
    assert io.exit_code == 127
    assert io.stderr == b"python3: needs the broken extra\n"


@pytest.mark.asyncio
async def test_run_source_unbound_refuses_without_hint():
    """No captured runtime means refusal, not a hidden interpreter."""
    prepared = Source(code="hi")
    stdout, io = await run_code("python3", prepared, None, {}, None, None)
    assert io.exit_code == 127
    assert io.stderr == b"python3: command not found\n"


def test_run_output_is_the_one_result_mapping():
    stdout, io = run_output(
        RunResult(stdout=b"out", stderr=b"err", exit_code=3))
    assert stdout == b"out"
    assert io.exit_code == 3
    assert io.stderr == b"err"


def test_run_output_empty_stdout_becomes_no_stream():
    stdout, io = run_output(RunResult(stdout=b"", stderr=None, exit_code=0))
    assert stdout is None
    assert io.exit_code == 0
    assert io.stderr is None
