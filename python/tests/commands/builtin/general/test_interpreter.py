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
                                                         run_code)
from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.types import PathSpec


class EchoRuntime(Runtime):
    name = "echo"

    def __init__(self, dispatch=None):
        self.seen: list[RunArgs] = []

    async def run(self, args: RunArgs) -> RunResult:
        self.seen.append(args)
        return RunResult(stdout=args.code.encode(), stderr=None, exit_code=0)


class BrokenRuntime(Runtime):
    name = "broken"

    def __init__(self, dispatch=None):
        raise ImportError("needs the broken extra")

    async def run(self, args: RunArgs) -> RunResult:
        raise AssertionError("unreachable")


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
                                runtime, EchoRuntime, (ImportError, ), None)
    assert io.exit_code == 0
    assert runtime.seen[0].flags == {"module": True}
    assert runtime.seen[0].env == {"K": "V"}


@pytest.mark.asyncio
async def test_run_source_fallback_failure_is_exit_127_hint():
    prepared = Source(code="hi")
    stdout, io = await run_code("python3", prepared, None, {}, None,
                                BrokenRuntime, (ImportError, ), None)
    assert io.exit_code == 127
    assert b"needs the broken extra" in io.stderr
