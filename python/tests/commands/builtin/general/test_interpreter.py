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

from mirage.commands.builtin.general.interpreter import (
    Relay,
    exec_refusal,
    line_output,
    not_bound,
    run_interpreter,
    run_output,
    runtime_version,
)
from mirage.commands.config import Context
from mirage.io.errors import MemoryExhausted
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.io.types import IOResult, materialize
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import CommandRuntime, Program, RunResult
from mirage.shell.console import Channel
from mirage.types import PathSpec


class EchoRuntime(LanguageRuntime):
    name = "echo"
    language = "python"

    async def interpret(
        self, engine, program: Program, ctx, output, errors
    ) -> RunResult:
        await output(program.code.encode())
        return RunResult(exit_code=0)


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
    assert await materialize(stdout) == b""
    assert io.exit_code == 1
    assert io.stderr == b"echo: version information unavailable\n"


def test_not_bound_answers_command_not_found():
    """No captured runtime means refusal, not a hidden interpreter."""
    stdout, io = not_bound("python3")
    assert io.exit_code == 127
    assert io.stderr == b"python3: command not found\n"


async def _ran(output, errors) -> RunResult:
    await output(b"out")
    await errors(b"err")
    return RunResult(exit_code=3)


async def _out_then_err(output, errors) -> RunResult:
    await output(b"a")
    await errors(b"e")
    return RunResult(exit_code=0)


async def _said_on_stderr(output, errors) -> RunResult:
    await errors(b"run\n")
    return RunResult(exit_code=0)


@pytest.mark.asyncio
async def test_run_output_settles_the_status_and_stderr_as_its_output_ends():
    stdout, io = run_output(_ran)
    assert io.output is not None and not io.output.settled
    assert await materialize(stdout) == b"out"
    assert (io.exit_code, io.stderr) == (3, b"err")
    assert io.output.settled


@pytest.mark.asyncio
async def test_run_output_hands_each_write_over_as_the_run_makes_it():
    later = asyncio.Event()

    async def run(output, errors):
        await output(b"first\n")
        await later.wait()
        await output(b"second\n")
        return RunResult(exit_code=0)

    stdout, _ = run_output(run)
    assert await anext(stdout) == b"first\n"
    later.set()
    assert await materialize(stdout) == b"second\n"


@pytest.mark.asyncio
async def test_run_output_holds_the_run_back_while_its_reader_is_behind():
    wrote = asyncio.Event()

    async def run(output, errors):
        await output(b"x" * (1 << 20))
        wrote.set()
        return RunResult(exit_code=0)

    stdout, _ = run_output(run)
    first = await anext(stdout)
    for _ in range(20):
        await asyncio.sleep(0)
    assert not wrote.is_set()
    rest = await materialize(stdout)
    assert len(first) + len(rest) == 1 << 20
    assert wrote.is_set()


@pytest.mark.asyncio
async def test_run_output_stops_the_run_when_its_reader_goes_away():
    stopped = asyncio.Event()

    class Input:
        closed = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

        async def aclose(self):
            self.closed = True

    async def run(output, errors):
        await output(b"a")
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
        return RunResult(exit_code=0)

    source = Input()
    stdout, io = run_output(run, stdin=source)
    assert await anext(stdout) == b"a"
    await stdout.aclose()
    assert stopped.is_set()
    assert io.exit_code == 141
    assert source.closed


@pytest.mark.asyncio
async def test_run_output_keeps_the_stderr_a_stopped_run_had_written():
    async def run(output, errors):
        await errors(b"warn\n")
        await output(b"a")
        await asyncio.Event().wait()
        return RunResult(exit_code=0)

    stdout, io = run_output(run)
    assert await anext(stdout) == b"a"
    await stdout.aclose()
    assert (io.exit_code, io.stderr) == (141, b"warn\n")


@pytest.mark.asyncio
async def test_run_output_writes_stderr_after_the_stdout_before_it():
    seen: list[tuple[str, bytes]] = []

    async def errors(chunk):
        seen.append(("err", chunk))

    stdout, io = run_output(_out_then_err, errors=errors)
    async for chunk in stdout:
        seen.append(("out", chunk))
    assert seen == [("out", b"a"), ("err", b"e")]
    assert io.stderr is None


@pytest.mark.asyncio
async def test_run_output_keeps_what_the_result_already_said_on_stderr():
    stdout, io = run_output(_said_on_stderr)
    io.stderr = b"warning\n"
    await materialize(stdout)
    assert io.stderr == b"warning\nrun\n"


@pytest.mark.asyncio
async def test_run_output_counts_the_stderr_it_keeps_against_the_memory_budget():
    stdout, _ = run_output(_errs_abcd_thrice)
    with pytest.raises(MemoryExhausted):
        await run_with_memory(MemoryBudget(8, lambda: 0), materialize(stdout))


@pytest.mark.asyncio
async def test_line_output_writes_stderr_to_the_callers_sink_in_order():
    seen: list[tuple[str, bytes]] = []

    async def errors(chunk):
        seen.append(("err", chunk))

    stdout, io = line_output(_out_err_out, sink=Relay(_unused, errors))
    async for chunk in stdout:
        seen.append(("out", chunk))
    assert seen == [("out", b"o1"), ("err", b"e1"), ("out", b"o2")]
    assert io.stderr is None


async def _errs_abcd_thrice(output, errors) -> RunResult:
    for _ in range(3):
        await errors(b"abcd")
    return RunResult(exit_code=0)


async def _out_err_out(console) -> IOResult:
    await console.emit(Channel.STDOUT, b"o1")
    await console.emit(Channel.STDERR, b"e1")
    await console.emit(Channel.STDOUT, b"o2")
    return IOResult()


async def _unused(chunk):
    raise AssertionError(chunk)


# The run starts as its output is read, so the workspace settles the
# runtime once that run has ended, not when the command returns.
@pytest.mark.asyncio
async def test_run_interpreter_settles_the_runtime_once_the_run_ends():
    said: list[str] = []

    class Recorded(EchoRuntime):
        async def interpret(
            self, engine, program: Program, ctx, output, errors
        ) -> RunResult:
            said.append("ran")
            return await super().interpret(
                engine, program, ctx, output, errors
            )

    async def settle() -> None:
        said.append("settled")

    out, _ = run_interpreter(
        Recorded(),
        [],
        [],
        Context(flags={"c": "x"}, runtime=CommandRuntime(settle=settle)),
    )
    assert said == []
    assert await materialize(out) == b"x"
    assert said == ["ran", "settled"]
