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

from mirage import RAMVFS, Workspace
from mirage.commands.config import Context
from mirage.context.session_context import current_caller
from mirage.execution.process.types import Process
from mirage.execution.types import MachineName
from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import RunResult


class MarkerRuntime(Runtime):
    name = "marker"
    captures = ("echo-run",)


def test_base_carries_no_capability_entry_points():
    # The base holds identity and config only; code, run_line and attach
    # belong to the tiers and mixins, detected by isinstance.
    rt = MarkerRuntime()
    with pytest.raises(UnsupportedExecutionError, match="code execution"):
        asyncio.run(rt.execute([], [], Context()))
    assert not hasattr(rt, "run_line")
    assert not hasattr(rt, "attach")
    assert not isinstance(rt, LanguageRuntime)
    assert not isinstance(rt, LineExecutorMixin)


def test_close_defaults_to_noop():
    asyncio.run(MarkerRuntime().close())


def test_uniform_constructor_defaults():
    rt = MarkerRuntime()
    assert rt.captures == ("echo-run",)
    assert rt.config == RuntimeConfig()


def test_captures_override():
    rt = MarkerRuntime(captures=["only-this"])
    assert rt.captures == ("only-this",)


def test_unknown_config_key_fails_loud():
    with pytest.raises(TypeError):
        MarkerRuntime(config={"no_such_knob": 1})


def test_reach_defaults_to_process():
    # A runtime that declares nothing gets the no-promise claim: it
    # may act around the workspace gate. Only an explicit "workspace"
    # narrows it.
    assert MarkerRuntime().reach == "process"


class StubEngine:
    name = "stub"


class SlowCloseRuntime(Runtime[StubEngine]):
    name = "slow-close"

    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = 0

    async def open_engine(self) -> StubEngine:
        return StubEngine()

    async def close_engine(self, engine: StubEngine) -> None:
        self.entered.set()
        await self.release.wait()
        self.closed += 1


@pytest.mark.asyncio
async def test_a_cancelled_close_still_closes_the_engine_and_a_retry_waits():
    # A host cancelling Workspace.close() mid close_engine must not leave
    # the engine open: the close keeps running, and the retried close
    # waits for it instead of finding nothing left to close.
    rt = SlowCloseRuntime()
    await rt.engine()
    first = asyncio.ensure_future(rt.close())
    await rt.entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    retry = asyncio.ensure_future(rt.close())
    await asyncio.sleep(0)
    assert not retry.done()
    rt.release.set()
    await retry
    assert rt.closed == 1


class SeenRuntime(Runtime, ProcessExecutorMixin):
    """A runtime past the workspace's reach, on machine ``box:b1``, that
    keeps the record of the process each program it runs runs as, and
    holds one named ``hold`` until ``release``."""

    name = "seen"
    reach = "remote"
    captures = ("probe", "hold")

    def __init__(self, reach: str = "remote") -> None:
        super().__init__()
        self.reach = reach
        self.seen: list[Process] = []
        self.release = asyncio.Event()

    @property
    def machine(self) -> MachineName:
        return MachineName("box", "b1")

    async def run_process(
        self, engine, paths, texts, ctx, output=None, errors=None
    ) -> RunResult:
        process = current_caller().process
        assert process is not None
        self.seen.append(process.record)
        if texts[0] == "hold":
            await self.release.wait()
        return RunResult(stdout=b"", stderr=None, exit_code=0)


async def _seen(line: str, reach: str = "remote") -> tuple[Process, str]:
    runtime = SeenRuntime(reach)
    ws = Workspace({"/data": RAMVFS()}, runtimes=[runtime, "workspace"])
    try:
        out = (await ws.shell(line)).stdout.decode()
        [process] = runtime.seen
        return process, out
    finally:
        await ws.close()


# A program a runtime runs past the workspace is a process of its own on
# the runtime's machine: a pipeline stage's when it is the stage's, a
# job's when it is the job's, including one ``exec`` replaces, as bash
# execs it there; a child of its shell otherwise, the session's shell
# staying across its lines, and of ``find`` and ``xargs``, which fork
# each one.
@pytest.mark.asyncio
async def test_a_program_past_the_workspace_is_a_process_of_its_own():
    alone, line = await _seen("probe; echo $$")
    assert (alone.parent, alone.command) == (int(line), "probe")
    assert (alone.machine, alone.runtime) == (MachineName("box", "b1"), "seen")
    stage, line = await _seen("echo $$; probe | cat")
    assert (stage.parent, stage.command, stage.runtime) == (
        int(line),
        "probe",
        "seen",
    )
    job, pid = await _seen("probe & echo $!; wait")
    assert (job.pid, job.runtime) == (int(pid), "seen")
    replaced, pid = await _seen("exec probe & echo $!; wait")
    assert (replaced.pid, replaced.runtime) == (int(pid), "seen")
    forked, pid = await _seen(
        "find /data -maxdepth 0 -exec probe {} \\; & echo $!; wait"
    )
    assert (forked.parent, forked.runtime) == (int(pid), "seen")
    batched, pid = await _seen(
        "/usr/bin/xargs probe </dev/null & echo $!; wait"
    )
    assert (batched.parent, batched.runtime) == (int(pid), "seen")


# A runtime the workspace reaches runs its program in its shell's process.
@pytest.mark.asyncio
async def test_a_program_the_workspace_reaches_stays_in_its_shell():
    process, line = await _seen("echo $$; probe", "workspace")
    assert (process.pid, process.runtime) == (int(line), None)


# A program's process stopped with its shell ends by the shell's signal.
@pytest.mark.asyncio
async def test_a_programs_process_ends_by_its_shells_signal():
    runtime = SeenRuntime()
    ws = Workspace({"/data": RAMVFS()}, runtimes=[runtime, "workspace"])
    try:
        line = asyncio.ensure_future(ws.shell("true; hold"))
        async with asyncio.timeout(5):
            while not runtime.seen:
                await asyncio.sleep(0.01)
        [shell] = [
            p
            for p in ws.process_table.live()
            if p.record.pid == runtime.seen[0].parent
        ]
        [program] = [
            p
            for p in ws.process_table.live()
            if p.record.pid == runtime.seen[0].pid
        ]
        assert shell.terminate(15)
        ended = await program.join()
        assert (ended.exit, ended.signal) == (143, 15)
        assert (await line).exit_code == 143
    finally:
        runtime.release.set()
        await ws.close()


# A program's process stopped alone answers 128 plus the signal, and its
# shell goes on.
@pytest.mark.asyncio
async def test_a_programs_process_stopped_alone_leaves_its_shell_running():
    runtime = SeenRuntime()
    ws = Workspace({"/data": RAMVFS()}, runtimes=[runtime, "workspace"])
    try:
        line = asyncio.ensure_future(ws.shell("true; hold; echo after $?"))
        async with asyncio.timeout(5):
            while not runtime.seen:
                await asyncio.sleep(0.01)
        [program] = [
            p
            for p in ws.process_table.live()
            if p.record.pid == runtime.seen[0].pid
        ]
        assert program.terminate(15)
        done = await line
        assert (done.exit_code, done.stdout) == (0, b"after 143\n")
    finally:
        runtime.release.set()
        await ws.close()
