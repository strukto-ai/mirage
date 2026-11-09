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
import threading
from concurrent.futures import Future

import pytest

from mirage.context.session_context import current_caller, run_as_process
from mirage.execution.constants import LOCAL_MACHINE
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.types import Process, ProcessState
from mirage.execution.types import MachineId, MachinePid, ProcessId
from mirage.types import PathSpec


def _info() -> Process:
    return Process(
        id=ProcessId("w", 7),
        session_id="a",
        line=None,
        parent=None,
        group=7,
        command="line",
        cwd=PathSpec.from_str_path("/"),
        machine=LOCAL_MACHINE,
        started_at=0.0,
    )


@pytest.mark.asyncio
async def test_a_program_hears_when_it_is_held_and_let_go():
    handle = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    heard: list[bool] = []
    forget = handle.on_hold(heard.append)
    assert heard == []
    handle.pauses[7] = Future()
    handle.tell_held()
    handle.tell_held()
    assert heard == [True]
    handle.pauses.clear()
    handle.tell_held()
    assert heard == [True, False]
    handle.pauses[7] = Future()
    handle.tell_held()
    forget()
    assert heard == [True, False, True, False]
    late: list[bool] = []
    handle.on_hold(late.append)
    assert late == [True]


async def _exits_3() -> int:
    return 3


async def _raises() -> int:
    raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_a_finished_runner_reports_its_code_and_its_pid():
    finished: list[int] = []
    handle = ProcessHandle(_info(), _exits_3, finished.append)
    handle.start()
    info = await handle.join()
    assert (info.state, info.exit, finished) == (
        ProcessState.EXITED,
        3,
        [7],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("eager", [False, True])
async def test_a_failing_runner_exits_1_with_its_failure(eager):
    finished: list[int] = []
    handle = ProcessHandle(_info(), _raises, finished.append)
    handle.start(eager)
    info = await handle.join()
    assert (info.exit, info.error, finished) == (1, "boom", [7])


@pytest.mark.asyncio
async def test_terminate_asks_once_and_the_runner_exits_137():
    started = asyncio.Event()

    async def run() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, bind=run_as_process
    )
    handle.start()
    await started.wait()
    assert handle.terminate() is True
    assert handle.terminate() is False
    info = await handle.join()
    assert (info.exit, info.signal) == (137, 9)


# A program the runner runs where an interrupt reaches it hands back what
# it returned; a stop of the runner itself still stops the runner.
@pytest.mark.asyncio
async def test_a_program_returns_unless_interrupted_and_a_stop_still_stops():
    started = asyncio.Event()
    outcome: list[tuple[int | None, int | None]] = []

    async def program() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    async def run() -> int:
        outcome.append(await handle.program(_exits_3))
        await handle.program(program)
        return 0

    handle = ProcessHandle(_info(), run, lambda _pid: None)
    handle.interrupt(2)
    handle.start()
    async with asyncio.timeout(5):
        await started.wait()
        assert handle.terminate()
        assert (await handle.join()).exit == 137
    assert outcome == [(3, None)]


# A native run reads the signal an interrupt stops its program with, so
# it hands the program INT rather than killing it; once the program is
# gone, nothing is stopping.
@pytest.mark.asyncio
async def test_an_interrupted_program_names_its_signal_until_it_ends():
    started = asyncio.Event()
    seen: list[int | None] = []

    async def program() -> int:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            seen.append(handle.interrupted)
        return 0

    async def run() -> int:
        _, signal = await handle.program(program)
        seen.append(handle.interrupted)
        return signal or 0

    handle = ProcessHandle(_info(), run, lambda _pid: None)
    handle.start()
    await started.wait()
    handle.interrupt(2)
    assert ((await handle.join()).exit, seen) == (2, [2, None])


# A program that takes only some signals runs on through the others.
@pytest.mark.asyncio
async def test_a_program_runs_on_through_a_signal_it_does_not_take():
    started = asyncio.Event()

    async def program() -> int:
        started.set()
        await asyncio.sleep(0.05)
        return 7

    async def run() -> int:
        outcome = await handle.program(program, frozenset({2}))
        assert outcome == (7, None)
        return 0

    handle = ProcessHandle(_info(), run, lambda _pid: None)
    handle.start()
    await started.wait()
    handle.interrupt(3)
    assert (await handle.join()).exit == 0


# A stop stands for the signal a kill named: the runner reads it from the
# caller it runs as, and its status is 128 plus it, as bash reports a
# child that signal ended.
@pytest.mark.asyncio
@pytest.mark.parametrize("signal,code", [(15, 143), (2, 130), (1, 129)])
async def test_a_runner_stopped_with_a_signal_exits_128_plus_it(signal, code):
    started = asyncio.Event()
    seen: list[int | None] = []

    async def run() -> int:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            runner = current_caller().process
            seen.append(runner.signal if runner is not None else None)
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, bind=run_as_process
    )
    handle.start()
    await started.wait()
    assert handle.signal is None
    assert handle.terminate(signal) is True
    info = await handle.join()
    assert (info.exit, handle.signal, seen) == (code, signal, [signal])


# A KILL while the runner still stops under a gentler signal takes over,
# for the runner and what it started, as a second ``kill -KILL`` does; a
# repeated stop does not.
@pytest.mark.asyncio
async def test_a_kill_takes_over_a_gentler_stop():
    started = asyncio.Event()
    children: list[int] = []

    async def run() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, children.append, run_as_process
    )
    handle.start()
    await started.wait()
    assert handle.terminate(15) is True
    assert handle.terminate(15) is False
    assert handle.terminate(9) is True
    assert handle.terminate(9) is False
    info = await handle.join()
    assert (info.exit, handle.signal, children) == (137, 9, [15, 9])


# A KILL another thread sends while the stopped runner settles is either
# refused or the status the runner reports: never accepted and lost.
@pytest.mark.asyncio
async def test_a_kill_racing_the_settle_is_the_status_it_reports():
    started = asyncio.Event()

    async def run() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, bind=run_as_process
    )
    handle.start()
    await started.wait()
    assert handle.terminate(15) is True
    held, killed = threading.Event(), []

    def other() -> None:
        with handle._lock:
            held.set()
            threading.Event().wait(0.2)
            killed.append(handle.terminate(9))

    thread = threading.Thread(target=other)
    thread.start()
    held.wait()
    info = await handle.join()
    thread.join()
    assert (killed, info.exit) == ([True], 137)


def test_a_program_that_takes_a_runner_ignores_only_what_it_inherits():
    handle = ProcessHandle(
        _info(), _exits_3, lambda _pid: None, ignores=frozenset({2, 3})
    )
    handle.one_command = True
    handle.program_ignores = frozenset({2})
    assert 3 in handle.ignores
    assert handle.take(None, "local")
    assert handle.ignores == frozenset({2})


# A runner started for one command is its program once, on the program's
# machine and runtime; one started for more, or taken already, is not, and
# a host program's pid lands on the record.
def test_a_runner_started_for_one_command_is_its_program_once():
    handle = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    assert not handle.take(None, "docker")
    handle.one_command = True
    assert handle.take(MachineId("docker", "tools"), "docker")
    assert not handle.take(None, "local")
    record = handle.record
    assert (record.machine, record.runtime) == (
        MachineId("docker", "tools"),
        "docker",
    )
    handle.set_machine_pid(MachinePid(41, 5.0))
    assert handle.record.machine_pid == MachinePid(41, 5.0)
    other = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    other.one_command = True
    assert other.take(None, "local")
    assert (other.record.machine, other.record.runtime) == (
        LOCAL_MACHINE,
        "local",
    )


# What a program the runner started exited with after handling the signal
# is the program's, kept apart from the runner's own 128 plus the signal.
@pytest.mark.asyncio
async def test_a_program_that_handled_the_signal_keeps_its_own_status():
    started = asyncio.Event()

    async def run() -> int:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            runner = current_caller().process
            assert runner is not None
            runner.program_exited(3)
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, bind=run_as_process
    )
    handle.start()
    await started.wait()
    assert handle.program_code is None
    assert handle.terminate(15) is True
    info = await handle.join()
    assert (info.exit, handle.program_code) == (143, 3)


# An eager start runs a runner that never waits to its end before start
# returns, so joining it takes no turn of the loop.
@pytest.mark.asyncio
async def test_an_eager_runner_that_never_waits_is_done_once_started():
    handle = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    handle.start(eager=True)
    assert handle.task.done()
    assert (await handle.join()).exit == 3


# A runner stopping itself while its eager start still runs (a `kill
# $BASHPID` before its first wait) is stopped like any other.
@pytest.mark.asyncio
async def test_a_runner_that_stops_itself_during_an_eager_start_exits_137():
    async def run() -> int:
        runner = current_caller().process
        assert runner is not None
        runner.terminate()
        await asyncio.Event().wait()
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, bind=run_as_process
    )
    handle.start(eager=True)
    info = await handle.join()
    assert (info.exit, info.signal) == (137, 9)


async def _hangs() -> int:
    await asyncio.Event().wait()
    return 0


# Reaping a runner waits for it as wait(2) does: its code, or 128 plus the
# signal that stopped it; one the host stopped (revoked) ends the wait
# cancelled, and a waiter cancelled itself stops the runner with it.
@pytest.mark.asyncio
async def test_reap_answers_a_status_unless_the_host_stopped_the_runner():
    done = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    done.start()
    assert await done.reap() == 3
    stopped = ProcessHandle(_info(), _hangs, lambda _pid: None)
    stopped.start()
    await asyncio.sleep(0)
    stopped.terminate(15)
    assert await stopped.reap() == 143
    revoked = ProcessHandle(_info(), _hangs, lambda _pid: None)
    revoked.start()
    await asyncio.sleep(0)
    revoked.revoked = True
    revoked.terminate()
    with pytest.raises(asyncio.CancelledError):
        await revoked.reap()
    waited = ProcessHandle(_info(), _hangs, lambda _pid: None)
    waited.start()
    waiter = asyncio.create_task(waited.reap())
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert (await waited.join()).exit == 137


def test_a_deadline_names_term_and_lets_a_stopped_process_go():
    handle = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    gate: Future[None] = Future()
    handle.pauses[7] = gate
    assert handle.paused and handle.interrupted is None
    handle.expire()
    assert not handle.paused and gate.done()
    assert handle.interrupted == 15
    assert handle.signal is None
