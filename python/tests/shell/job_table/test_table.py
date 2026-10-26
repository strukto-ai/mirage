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
from functools import partial

import pytest

from mirage.io import IOResult
from mirage.shell.console import (
    Channel,
    ConsoleStore,
    JobConsole,
    RAMConsoleStore,
)
from mirage.shell.console.types import ConsoleChunk, ReadResult
from mirage.shell.job_table.ram import RAMJobStore
from mirage.shell.job_table.table import JobTable
from mirage.shell.job_table.types import Job, JobStatus
from mirage.utils.clock import ManualClock
from mirage.workspace.types import ExecutionNode


class _GatedStore:
    """A store whose appends park until the test opens the gate.

    Stands in for a store that genuinely suspends (Redis) or a waiter on
    another loop: the window between a job's status flipping and its
    final chunks landing becomes arbitrarily wide.
    """

    def __init__(self, gate: asyncio.Event) -> None:
        self._gate = gate
        self._inner = RAMConsoleStore()

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        await self._gate.wait()
        return await self._inner.append(channel, data)

    async def read_from(
        self, seq: int, limit: int | None = None
    ) -> ReadResult:
        return await self._inner.read_from(seq, limit)

    @property
    def closed(self) -> bool:
        return self._inner.closed

    async def wait(self, seq: int) -> None:
        await self._inner.wait(seq)

    async def wait_ended(self) -> None:
        await self._inner.wait_ended()

    async def close(self) -> None:
        await self._inner.close()


async def _run_forever(job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (Job): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


class _BrokenConsoles(RAMJobStore):
    """A job store that cannot open a console."""

    def console(self, name: str) -> ConsoleStore:
        raise ValueError("console unavailable")


async def _submit_gated(table: JobTable, gate: asyncio.Event) -> Job:
    job = await table.submit(command="deaf", run=_run_forever, cwd="/")
    job.console = JobConsole(store=_GatedStore(gate))
    return job


@pytest.mark.asyncio
async def test_wait_joins_a_kill_still_appending_its_marker():
    """``wait`` must not return between the status flip and the appends.

    ``kill`` sets KILLED before emitting ``Killed`` and the ending
    chunk, so a wait that trusts the status field lets the caller
    snapshot and reap without the marker. Joining on the console's
    ending chunk closes the window.
    """
    gate = asyncio.Event()
    table = JobTable()
    job = await _submit_gated(table, gate)
    kill_task = asyncio.create_task(table.kill(job.id))
    await asyncio.sleep(0)
    assert job.status is JobStatus.KILLED
    waiter = asyncio.create_task(table.wait(job.id))
    await asyncio.sleep(0)
    # The status has flipped but the marker has not landed; a wait that
    # returned here would snapshot without it.
    assert not waiter.done()
    gate.set()
    await asyncio.wait_for(kill_task, 2)
    waited = await asyncio.wait_for(waiter, 2)
    assert await waited.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_wait_all_joins_a_killed_job_still_appending():
    """``wait_all`` covers killed jobs too, not only the running ones.

    Bare ``wait`` snapshots every console right after ``wait_all``
    returns, so a killed-but-mid-append job skipped by a running-only
    filter would lose its marker the same way.
    """
    gate = asyncio.Event()
    table = JobTable()
    job = await _submit_gated(table, gate)
    kill_task = asyncio.create_task(table.kill(job.id))
    await asyncio.sleep(0)
    assert job.status is JobStatus.KILLED
    all_waiter = asyncio.create_task(table.wait_all())
    await asyncio.sleep(0)
    assert not all_waiter.done()
    gate.set()
    await asyncio.wait_for(kill_task, 2)
    await asyncio.wait_for(all_waiter, 2)
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_a_child_table_keeps_its_jobs_off_the_shared_store():
    store = RAMJobStore()
    table = JobTable(store)
    child = table.child().child(table)
    job = await child.submit(command="deaf", run=_run_forever, cwd="/")
    assert child.processes is table.processes
    assert child.parent is table
    assert child.store is not store
    assert table.list_jobs() == []
    assert await store.load("") is None
    await child.kill(job.id)


@pytest.mark.asyncio
async def test_close_leaves_consoles_open():
    table = JobTable()
    job = await table.submit(command="deaf", run=_run_forever, cwd="/")
    await table.kill(job.id)
    await table.close()
    assert job.console.store.closed is False


@pytest.mark.asyncio
async def test_settle_kill_marker_survives_second_cancel():
    """A cancel landing while the marker is mid-write must not lose it.

    The runner's task is cancelled directly (not via ``kill``), enters
    the settle branch, and parks on the gated append; a second cancel
    then hits the task. The shield keeps the marker write running, so
    once the gate opens the console still ends with the marker and the
    killed outcome. Without the shield the second cancel aborts the
    emit and the ending chunk never lands, stranding every reader.
    """
    gate = asyncio.Event()
    table = JobTable()
    job = await _submit_gated(table, gate)
    await asyncio.sleep(0)
    assert job.process is not None
    job.process.task.cancel()
    await asyncio.sleep(0.01)
    assert job.status is JobStatus.KILLED
    job.process.task.cancel()
    await asyncio.sleep(0.01)
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(job.process.task, 2)
    await asyncio.wait_for(job.console.wait_finished(), 2)
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


async def _submit(table: JobTable, session_id: str, command: str = "x") -> Job:
    return await table.submit(
        command=command, run=_run_forever, cwd="/", session_id=session_id
    )


@pytest.mark.asyncio
async def test_each_session_numbers_its_jobs_from_one():
    table = JobTable()
    a1 = await _submit(table, "a")
    b1 = await _submit(table, "b")
    a2 = await _submit(table, "a")
    assert (a1.id, b1.id, a2.id) == (1, 1, 2)
    await table.kill_all()


@pytest.mark.asyncio
async def test_views_are_scoped_to_one_session():
    table = JobTable()
    a1 = await _submit(table, "a")
    b1 = await _submit(table, "b")
    assert table.list_jobs("a") == [a1]
    assert table.running_jobs("b") == [b1]
    assert table.get(1, "b") is b1
    assert table.get(2, "b") is None
    assert table.list_jobs() == []
    assert sorted(j.session_id for j in table.all_jobs()) == ["a", "b"]
    await table.kill_all()


@pytest.mark.asyncio
async def test_kill_all_reaches_every_session():
    table = JobTable()
    a1 = await _submit(table, "a")
    b1 = await _submit(table, "b")
    killed = await table.kill_all()
    assert {j.session_id for j in killed} == {"a", "b"}
    assert a1.status is JobStatus.KILLED
    assert b1.status is JobStatus.KILLED
    assert table.all_running_jobs() == []


# kill %N with a signal records bash's status for it: 128 plus the signal.
@pytest.mark.asyncio
@pytest.mark.parametrize("signal,code", [(9, 137), (15, 143), (2, 130)])
async def test_a_job_killed_with_a_signal_exits_128_plus_it(signal, code):
    table = JobTable()
    job = await _submit(table, "a")
    await asyncio.sleep(0)
    assert await table.kill(job.id, "a", signal)
    assert (job.status, job.exit_code) == (JobStatus.KILLED, code)
    assert job.process is not None
    assert (await job.process.join()).exit_code == code


async def _submit_handling(
    table: JobTable, simple: bool, stopped: list[str]
) -> tuple[Job, asyncio.Event]:
    started = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.05)
            assert job.process is not None
            job.process.program_exited(3)
            stopped.append("handled")
        return IOResult(), ExecutionNode()

    return await table.submit("prog", run, "/", simple=simple), started


# bash's `wait` returns once a killed child has gone, with the status it
# exited with when it handled the signal; a compound job is a shell the
# signal ends. The status is the job's once its runner ends, so a
# snapshot taken before any `wait` keeps it too.
@pytest.mark.asyncio
@pytest.mark.parametrize("simple,code", [(True, 3), (False, 143)])
async def test_wait_joins_a_killed_job_and_takes_its_program_status(
    simple, code
):
    table = JobTable()
    stopped: list[str] = []
    job, started = await _submit_handling(table, simple, stopped)
    await started.wait()
    assert await table.kill(job.id, "", 15)
    assert (job.exit_code, stopped) == (143, [])
    assert job.process is not None
    await job.process.join()
    assert (job.exit_code, stopped) == (code, ["handled"])
    assert (await table.wait(job.id)).exit_code == code


@pytest.mark.asyncio
async def test_wait_answers_the_kill_once_a_runner_outlasts_the_bound(
    monkeypatch,
):
    monkeypatch.setattr("mirage.shell.job_table.table.STOP_WAIT_SECONDS", 0.05)
    table = JobTable()
    release = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.shield(release.wait())
        return IOResult(), ExecutionNode()

    job = await table.submit("deaf", run, "/", simple=True)
    await asyncio.sleep(0)
    assert await table.kill(job.id, "", 15)
    async with asyncio.timeout(2):
        assert (await table.wait(job.id)).exit_code == 143
    release.set()
    assert job.process is not None
    await job.process.join()


@pytest.mark.asyncio
async def test_numbering_resets_per_session_when_its_list_empties():
    table = JobTable()
    a1 = await _submit(table, "a")
    await _submit(table, "b")
    assert await table.kill(a1.id, "a")
    await table.reap(a1.id, "a")
    assert (await _submit(table, "a")).id == 1
    assert (await _submit(table, "b")).id == 2
    await table.kill_all()


@pytest.mark.asyncio
async def test_close_session_stops_and_forgets_its_jobs():
    table = JobTable()
    a1 = await _submit(table, "a")
    a2 = await _submit(table, "a")
    b1 = await _submit(table, "b")
    assert await table.disown(a2.id, "a")
    assert await table.close_session("a") == [a1]
    assert a1.status is JobStatus.KILLED
    # Disowned: off the list, still running, bash's own rule.
    assert a2.status is JobStatus.RUNNING
    assert table.list_jobs("a") == []
    assert table.get(1, "a") is None
    assert table.list_jobs("b") == [b1]
    # A session reusing the id starts from one and inherits nothing.
    assert (await _submit(table, "a")).id == 1
    await table.kill_all()
    assert a2.status is JobStatus.KILLED


@pytest.mark.asyncio
async def test_load_restores_a_job_into_its_session():
    table = JobTable()
    restored = Job(
        id=3,
        command="x",
        cwd="/",
        created_at=0.0,
        status=JobStatus.COMPLETED,
        session_id="a",
    )
    await table.load(restored)
    assert table.get(3, "a") is restored
    assert table.get(3) is None
    assert (await _submit(table, "a")).id == 4
    assert (await _submit(table, "b")).id == 1
    await table.kill_all()


@pytest.mark.asyncio
async def test_disowned_job_keeps_process_identity_until_runner_really_exits():
    table = JobTable()
    entered, release = asyncio.Event(), asyncio.Event()

    async def run(job):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
        return IOResult(exit_code=0), ExecutionNode()

    job = await table.submit(command="long", run=run, cwd="/", session_id="a")
    await entered.wait()
    process = job.process
    assert process is not None
    view = table.processes.view("a")
    assert await table.disown(job.id, "a")
    assert table.list_jobs("a") == []
    assert [i.pid for i in view.list()] == [process.info.pid]
    await table.kill_all()
    assert job.status == JobStatus.KILLED
    assert [i.state for i in view.list()] == ["stopping"]
    release.set()
    result = await process.join()
    assert result.exit_code == 0
    assert result.cancellation_requested
    assert view.list() == ()


@pytest.mark.asyncio
async def test_process_ids_do_not_restart_with_shell_job_numbers():
    table = JobTable()
    a = await _submit(table, "a")
    b = await _submit(table, "b")
    assert a.id == b.id == 1
    assert a.process.info.pid != b.process.info.pid
    await table.kill(a.id, "a")
    await table.reap(a.id, "a")
    replacement = await _submit(table, "a")
    assert replacement.id == 1
    assert replacement.process.info.pid > b.process.info.pid
    await table.kill_all()
    await asyncio.gather(
        a.process.join(), b.process.join(), replacement.process.join()
    )


@pytest.mark.asyncio
async def test_a_refused_job_gives_its_number_back():
    store = RAMJobStore()
    table = JobTable(store)
    release = asyncio.Event()

    async def run(job):
        await release.wait()
        return IOResult(), ExecutionNode()

    job = await table.submit(command="held", run=run, cwd="/", limit=1)
    try:
        for _ in range(3):
            with pytest.raises(BlockingIOError):
                await table.submit(
                    command="refused", run=run, cwd="/", limit=1
                )
        assert table.list_jobs() == [job]
        stored = await store.load("")
        assert stored is not None
        assert list(stored["jobs"]) == ["1"]
        assert stored["next"] == 2
    finally:
        release.set()
        await table.processes.drain()


@pytest.mark.asyncio
async def test_a_console_failure_never_enters_job_runner():
    entered = []

    async def run(job):
        entered.append("runner")
        return IOResult(), ExecutionNode()

    store = _BrokenConsoles()
    table = JobTable(store)
    with pytest.raises(ValueError, match="console unavailable"):
        await table.submit(command="refused", run=run, cwd="/", limit=1)
    await table.processes.drain()
    assert table.list_jobs() == []
    assert table.processes.live() == ()
    assert entered == []
    stored = await store.load("")
    assert stored is not None
    assert stored["jobs"] == {}


@pytest.mark.asyncio
async def test_a_substitution_lists_its_callers_jobs_before_its_own():
    caller = JobTable()
    outer = await caller.submit("outer", _run_forever, cwd="/")
    inner_table = JobTable(processes=caller.processes, parent=caller)
    inner = await inner_table.submit("inner", _run_forever, cwd="/")
    assert inner_table.listing() == [outer, inner]
    assert inner_table.list_jobs() == [inner]


@pytest.mark.asyncio
async def test_jobs_are_stamped_on_the_table_clock():
    clock = ManualClock(start=1_000.0)
    table = JobTable(clock=clock)
    first = await table.submit(command="deaf", run=_run_forever, cwd="/")
    clock.advance(5)
    child = table.child()
    second = await child.submit(command="deaf", run=_run_forever, cwd="/")
    try:
        assert (first.created_at, second.created_at) == (1_000.0, 1_005.0)
    finally:
        await table.kill_all()
        await child.kill_all()


async def _exit_with(code: int, job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that exits at once with ``code``.

    Args:
        code (int): the exit status.
        job (Job): the job being run.
    """
    return IOResult(exit_code=code), ExecutionNode(exit_code=code)


@pytest.mark.asyncio
async def test_another_table_lists_waits_on_and_kills_a_job():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0)
    await b.sync("s")
    [seen] = b.list_jobs("s")
    assert (seen.id, seen.command, seen.status) == (
        1,
        "sleep 30",
        JobStatus.RUNNING,
    )
    assert seen.process is None
    assert await b.kill(1, "s", 15)
    assert (await b.wait(1, "s")).exit_code == 143
    assert job.process is not None
    async with asyncio.timeout(2):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 143)
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_another_table_waits_for_a_job_to_end():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    gate = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        await gate.wait()
        return IOResult(exit_code=1), ExecutionNode(exit_code=1)

    await a.submit("false", run, "/", session_id="s")
    await b.sync("s")
    waiter = asyncio.ensure_future(b.wait(1, "s"))
    await asyncio.sleep(0.01)
    assert not waiter.done()
    gate.set()
    async with asyncio.timeout(2):
        assert (await waiter).exit_code == 1


@pytest.mark.asyncio
async def test_two_tables_never_hand_out_one_number():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    first, second = await asyncio.gather(
        a.submit("one", _run_forever, "/", session_id="s"),
        b.submit("two", _run_forever, "/", session_id="s"),
    )
    assert {first.id, second.id} == {1, 2}
    await b.sync("s")
    assert [j.id for j in b.list_jobs("s")] == [1, 2]
    await a.kill_all()
    await b.kill_all()


@pytest.mark.asyncio
async def test_a_job_whose_owner_lapsed_ends_as_hung_up():
    store = RAMJobStore(lease_seconds=0.05)
    a, b = JobTable(store), JobTable(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0)
    assert a._lease is not None
    a._lease.cancel()
    await b.sync("s")
    assert b.running_jobs("s") != []
    await asyncio.sleep(0.1)
    async with asyncio.timeout(2):
        assert (await b.wait(1, "s")).exit_code == 129
    assert b.get(1, "s").status is JobStatus.KILLED
    assert job.process is not None
    async with asyncio.timeout(2):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 129)


@pytest.mark.asyncio
async def test_a_reap_elsewhere_drops_the_job_from_its_owner():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    await a.submit("true", partial(_exit_with, 0), "/", session_id="s")
    await b.sync("s")
    assert (await b.wait(1, "s")).exit_code == 0
    await b.reap(1, "s")
    await a.sync("s")
    assert a.list_jobs("s") == []
    assert (await a.submit("next", _run_forever, "/", session_id="s")).id == 1
    await a.kill_all()
