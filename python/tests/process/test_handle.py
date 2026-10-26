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

import pytest

from mirage.context.session_context import current_caller, run_with_execution
from mirage.process.handle import ProcessHandle
from mirage.process.types import ProcessInfo, ProcessState
from mirage.types import PathSpec


def _info() -> ProcessInfo:
    return ProcessInfo(
        pid=7,
        session_id="a",
        command="line",
        cwd=PathSpec.from_str_path("/"),
        started_at=0.0,
        execution_id="exec_test",
    )


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
    assert (info.state, info.exit_code, finished) == (
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
    assert (info.exit_code, info.failure, finished) == (1, "boom", [7])


@pytest.mark.asyncio
async def test_terminate_asks_once_and_the_runner_exits_137():
    started = asyncio.Event()

    async def run() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    handle = ProcessHandle(
        _info(), run, lambda _pid: None, bind=run_with_execution
    )
    handle.start()
    await started.wait()
    assert handle.terminate() is True
    assert handle.terminate() is False
    info = await handle.join()
    assert (info.exit_code, info.cancellation_requested) == (137, True)


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
        _info(), run, lambda _pid: None, bind=run_with_execution
    )
    handle.start()
    await started.wait()
    assert handle.signal is None
    assert handle.terminate(signal) is True
    info = await handle.join()
    assert (info.exit_code, handle.signal, seen) == (code, signal, [signal])


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
        _info(), run, lambda _pid: None, children.append, run_with_execution
    )
    handle.start()
    await started.wait()
    assert handle.terminate(15) is True
    assert handle.terminate(15) is False
    assert handle.terminate(9) is True
    assert handle.terminate(9) is False
    info = await handle.join()
    assert (info.exit_code, handle.signal, children) == (137, 9, [15, 9])


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
        _info(), run, lambda _pid: None, bind=run_with_execution
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
    assert (killed, info.exit_code) == ([True], 137)


# The native runs a runner has going are kept under their keys until each
# ends, and the view of them is a copy.
def test_a_runner_keeps_the_native_runs_it_has_going():
    handle = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    handle.add_run("host:41", {"host": "h", "pid": 41})
    handle.add_run("box:t", {"runtime": "docker", "tag": "t"})
    handle.runs.clear()
    assert handle.runs == {
        "host:41": {"host": "h", "pid": 41},
        "box:t": {"runtime": "docker", "tag": "t"},
    }
    handle.drop_run("host:41")
    handle.drop_run("host:41")
    assert handle.runs == {"box:t": {"runtime": "docker", "tag": "t"}}


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
        _info(), run, lambda _pid: None, bind=run_with_execution
    )
    handle.start()
    await started.wait()
    assert handle.program_code is None
    assert handle.terminate(15) is True
    info = await handle.join()
    assert (info.exit_code, handle.program_code) == (143, 3)


# An eager start runs a runner that never waits to its end before start
# returns, so joining it takes no turn of the loop.
@pytest.mark.asyncio
async def test_an_eager_runner_that_never_waits_is_done_once_started():
    handle = ProcessHandle(_info(), _exits_3, lambda _pid: None)
    handle.start(eager=True)
    assert handle.task.done()
    assert (await handle.join()).exit_code == 3


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
        _info(), run, lambda _pid: None, bind=run_with_execution
    )
    handle.start(eager=True)
    info = await handle.join()
    assert (info.exit_code, info.cancellation_requested) == (137, True)
