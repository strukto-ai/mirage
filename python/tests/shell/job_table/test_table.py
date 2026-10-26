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
from collections.abc import Awaitable, Callable
from functools import partial

import pytest

from mirage.io import IOResult
from mirage.process.config import ProcessPermissions
from mirage.process.table import ProcessTable
from mirage.shell.console import (
    Channel,
    ConsoleStore,
    JobConsole,
    RAMConsoleStore,
)
from mirage.shell.console.types import ConsoleChunk, ReadResult
from mirage.shell.job_table import table as table_module
from mirage.shell.job_table.ram import RAMJobStore
from mirage.shell.job_table.table import JobTable
from mirage.shell.job_table.types import Job, JobStatus
from mirage.types import PathSpec
from mirage.utils.clock import ManualClock
from mirage.workspace.record.types import RecordFields, generation_of
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


@pytest.mark.asyncio
async def test_a_stale_reap_never_drops_a_job_that_took_its_number():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    await a.submit("true", partial(_exit_with, 0), "/", session_id="s")
    await a.wait(1, "s")
    await b.sync("s")
    await b.reap(1, "s")
    fresh = await b.submit("sleep 30", _run_forever, "/", session_id="s")
    assert fresh.id == 1
    assert [j.command for j in await a.pop_completed("s")] == ["true"]
    await b.sync("s")
    assert [j.command for j in b.list_jobs("s")] == ["sleep 30"]
    await b.kill_all()


@pytest.mark.asyncio
async def test_a_sync_takes_the_job_that_took_a_reaped_number():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    await a.submit("true", partial(_exit_with, 0), "/", session_id="s")
    await a.wait(1, "s")
    await b.sync("s")
    await b.reap(1, "s")
    await b.submit("sleep 30", _run_forever, "/", session_id="s")
    await a.sync("s")
    [seen] = a.list_jobs("s")
    assert (seen.command, seen.status) == ("sleep 30", JobStatus.RUNNING)
    assert await a.pop_completed("s") == []
    await b.sync("s")
    assert [j.command for j in b.list_jobs("s")] == ["sleep 30"]
    await b.kill_all()


# A program that handled the kill leaves its own status, and the ending
# every workspace reads carries it, not the signal's.
@pytest.mark.asyncio
async def test_a_handled_kill_answers_one_status_everywhere():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    stopped: list[str] = []
    job, started = await _submit_handling(a, True, stopped)
    await started.wait()
    await b.sync()
    assert await a.kill(job.id, "", 15)
    async with asyncio.timeout(2):
        assert (await b.wait(job.id)).exit_code == 3
        assert (await a.wait(job.id)).exit_code == 3
    assert stopped == ["handled"]


@pytest.mark.asyncio
async def test_a_kill_before_the_runner_begins_ends_the_console_at_once():
    table = JobTable()
    job = await table.submit("never", _run_forever, "/")
    assert await table.kill(job.id, "", 15)
    async with asyncio.timeout(2):
        assert (await table.wait(job.id)).exit_code == 143
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_close_ends_a_killed_job_still_stopping():
    table = JobTable()
    release = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.shield(release.wait())
        return IOResult(), ExecutionNode()

    job = await table.submit("deaf", run, "/")
    await asyncio.sleep(0)
    assert await table.kill(job.id, "", 15)
    assert not job.console.finished
    await table.close()
    assert await job.console.outcome() == "killed:143"
    release.set()
    assert job.process is not None
    await job.process.join()


class _FailsFirstWatch:
    """A console whose first watch fails, as a dropped connection does."""

    def __init__(self, inner: ConsoleStore) -> None:
        self._inner = inner
        self._failed = False

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
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
        if not self._failed:
            self._failed = True
            raise ConnectionError("connection dropped")
        await self._inner.wait_ended()

    async def close(self) -> None:
        await self._inner.close()


class _DroppedWatches(RAMJobStore):
    """A job store whose consoles each fail their first watch."""

    def console(self, name: str) -> ConsoleStore:
        return _FailsFirstWatch(super().console(name))


@pytest.mark.asyncio
async def test_a_watch_that_failed_a_read_still_heeds_a_kill(monkeypatch):
    monkeypatch.setattr(
        "mirage.shell.job_table.table.WATCH_RETRY_SECONDS", 0.01
    )
    store = _DroppedWatches()
    a, b = JobTable(store), JobTable(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0.02)
    await b.sync("s")
    assert await b.kill(1, "s", 15)
    assert job.process is not None
    async with asyncio.timeout(2):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 143)


class _ExpiringOutput(RAMJobStore):
    """A job store whose consoles' output can expire, as Redis's does."""

    def __init__(self, lease_seconds: float | None = None) -> None:
        super().__init__(lease_seconds)
        self.expired: set[str] = set()

    def console(self, name: str) -> ConsoleStore:
        if name in self.expired:
            return RAMConsoleStore()
        return super().console(name)


@pytest.mark.asyncio
async def test_a_finished_job_outlives_its_expired_output():
    store = _ExpiringOutput(lease_seconds=0.05)
    a = JobTable(store)
    job = await a.submit("true", partial(_exit_with, 0), "/", session_id="s")
    assert job.process is not None
    await job.process.join()
    store.expired.add(job.console_name)
    await asyncio.sleep(0.1)
    fresh = JobTable(store)
    await fresh.sync("s")
    [seen] = fresh.list_jobs("s")
    assert (seen.status, seen.exit_code) == (JobStatus.COMPLETED, 0)


class _CountedWaits:
    """A console that counts the reads parked on it at once."""

    def __init__(self, inner: ConsoleStore, count: dict[str, int]) -> None:
        self._inner = inner
        self._count = count

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        return await self._inner.append(channel, data)

    async def read_from(
        self, seq: int, limit: int | None = None
    ) -> ReadResult:
        return await self._inner.read_from(seq, limit)

    @property
    def closed(self) -> bool:
        return self._inner.closed

    async def wait(self, seq: int) -> None:
        self._count["parked"] += 1
        self._count["most"] = max(self._count["most"], self._count["parked"])
        try:
            await self._inner.wait(seq)
        finally:
            self._count["parked"] -= 1

    async def wait_ended(self) -> None:
        await self._inner.wait_ended()

    async def close(self) -> None:
        await self._inner.close()


class _CountingWaits(RAMJobStore):
    """A job store whose consoles count the reads parked on them."""

    def __init__(self, lease_seconds: float | None = None) -> None:
        super().__init__(lease_seconds)
        self.count = {"parked": 0, "most": 0}

    def console(self, name: str) -> ConsoleStore:
        return _CountedWaits(super().console(name), self.count)


@pytest.mark.asyncio
async def test_a_long_wait_elsewhere_keeps_one_read_across_lease_checks():
    store = _CountingWaits(lease_seconds=0.03)
    a, b = JobTable(store), JobTable(store)
    gate = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        await gate.wait()
        return IOResult(), ExecutionNode()

    await a.submit("slow", run, "/", session_id="s")
    await b.sync("s")
    waiting = asyncio.ensure_future(b.wait(1, "s"))
    await asyncio.sleep(0.1)
    gate.set()
    async with asyncio.timeout(2):
        assert (await waiting).exit_code == 0
    assert store.count["most"] == 1


class _HookAfterRead(RAMJobStore):
    """A job store that runs one hook right after a list read, as another
    workspace's write landing between a read and what follows it."""

    def __init__(self) -> None:
        super().__init__()
        self.after_read: Callable[[], Awaitable[None]] | None = None

    async def load(self, session_id: str) -> RecordFields | None:
        fields = await super().load(session_id)
        hook, self.after_read = self.after_read, None
        if hook is not None:
            await hook()
        return fields


@pytest.mark.asyncio
async def test_a_sync_never_attaches_a_console_reaped_after_its_read():
    store = _HookAfterRead()
    a, b = JobTable(store), JobTable(store)
    gate = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        await gate.wait()
        return IOResult(), ExecutionNode()

    job = await a.submit("slow", run, "/", session_id="s")

    async def end_and_reap() -> None:
        gate.set()
        assert job.process is not None
        await job.process.join()
        await a.reap(1, "s")

    store.after_read = end_and_reap
    await b.sync("s")
    assert b.list_jobs("s") == []


@pytest.mark.asyncio
async def test_a_close_elsewhere_stops_a_disowned_job():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0)
    await b.sync("s")
    assert await b.disown(1, "s")
    assert (await b.submit("next", _run_forever, "/", session_id="s")).id == 1
    await b.close_session("s")
    assert job.process is not None
    async with asyncio.timeout(2):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 137)


@pytest.mark.asyncio
async def test_a_disowned_job_drops_its_record_when_it_ends():
    store = RAMJobStore()
    table = JobTable(store)
    gate = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        await gate.wait()
        return IOResult(), ExecutionNode()

    job = await table.submit("slow", run, "/", session_id="s")
    assert await table.disown(job.id, "s")
    held = await store.load("s")
    assert held is not None and list(held["disowned"]) == [job.console_name]
    gate.set()
    assert job.process is not None
    await job.process.join()
    ended = await store.load("s")
    assert ended is not None and "disowned" not in ended
    assert table._disowned == []


@pytest.mark.asyncio
async def test_a_job_started_during_a_sync_stays_this_tables_own():
    store = _HookAfterRead()
    table = JobTable(store)
    started: list[Job] = []

    async def launch() -> None:
        started.append(
            await table.submit("sleep 30", _run_forever, "/", session_id="s")
        )

    store.after_read = launch
    await table.sync("s")
    [job] = started
    assert table.get(job.id, "s") is job
    assert job.process is not None
    await table.kill_all()


@pytest.mark.asyncio
async def test_a_disown_never_parks_a_job_that_already_ended():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    gate = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        await gate.wait()
        return IOResult(), ExecutionNode()

    job = await a.submit("slow", run, "/", session_id="s")
    await b.sync("s")
    gate.set()
    assert job.process is not None
    await job.process.join()
    assert await b.disown(1, "s")
    stored = await store.load("s")
    assert stored is not None and "disowned" not in stored


class _CancelledAfterWrite(RAMJobStore):
    """A job store whose first list write lands but whose caller is
    cancelled before it hears so, as a cancel racing a Redis reply."""

    def __init__(self) -> None:
        super().__init__()
        self.cancel_once = True

    async def cas_set(
        self, session_id: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        written = await super().cas_set(
            session_id, fields, expected_generation
        )
        if written and self.cancel_once:
            self.cancel_once = False
            raise asyncio.CancelledError
        return written


@pytest.mark.asyncio
async def test_a_launch_cancelled_after_its_write_leaves_no_entry():
    store = _CancelledAfterWrite()
    table = JobTable(store)
    with pytest.raises(asyncio.CancelledError):
        await table.submit("sleep 30", _run_forever, "/", session_id="s")
    stored = await store.load("s")
    assert stored is not None and stored["jobs"] == {}
    assert (
        await table.submit("next", _run_forever, "/", session_id="s")
    ).id == 1
    await table.kill_all()


@pytest.mark.asyncio
async def test_a_restore_never_hides_a_job_that_holds_its_number():
    store = RAMJobStore()
    a, b = JobTable(store), JobTable(store)
    live = await b.submit("sleep 30", _run_forever, "/", session_id="s")
    restored = Job(
        id=live.id,
        command="old",
        cwd="/",
        created_at=0.0,
        status=JobStatus.COMPLETED,
        session_id="s",
        console=JobConsole(finished=True),
    )
    await a.load(restored)
    assert restored.id == live.id + 1
    await b.sync("s")
    assert [(j.id, j.command) for j in b.list_jobs("s")] == [
        (live.id, "sleep 30"),
        (live.id + 1, "old"),
    ]
    await b.kill_all()


class _Unwatched(_FailsFirstWatch):
    """A console whose watch never wakes, as an owner that has not looked
    at it yet."""

    async def wait_ended(self) -> None:
        await asyncio.Event().wait()


class _UnwatchedConsoles(RAMJobStore):
    """A job store whose owners never notice an ending on their own."""

    def console(self, name: str) -> ConsoleStore:
        return _Unwatched(super().console(name))


@pytest.mark.asyncio
async def test_a_number_retaken_elsewhere_lists_the_new_job():
    store = _UnwatchedConsoles()
    a, b = JobTable(store), JobTable(store)
    old = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0)
    await b.sync("s")
    assert await b.kill(1, "s", 15)
    assert (await b.wait(1, "s")).exit_code == 143
    await b.reap(1, "s")
    await b.submit("next", _run_forever, "/", session_id="s")
    await a.sync("s")
    listed = a.get(1, "s")
    assert listed is not None and listed.command == "next"
    assert old.status is JobStatus.RUNNING
    await a.kill_all()
    assert old.process is not None
    async with asyncio.timeout(2):
        await old.process.join()
    await b.kill_all()


@pytest.mark.asyncio
async def test_a_kill_before_the_runner_begins_keeps_its_ending_and_lease():
    store = RAMJobStore(lease_seconds=30)
    table = JobTable(store)
    job = await table.submit("never", _run_forever, "/", session_id="s")
    assert await table.kill(job.id, "s", 15)
    stored = await store.load("s")
    assert stored is not None
    assert stored["jobs"][str(job.id)]["ending"] == "killed:143"
    assert table._lease is None


class _StartsOnDelete(RAMJobStore):
    """A job store on which another table starts a job just as a list is
    about to go; with ``replaces``, after another close deleted it."""

    def __init__(self, replaces: bool = False) -> None:
        super().__init__()
        self.replaces = replaces
        self.peer: JobTable | None = None
        self.started: list[Job] = []

    async def delete(self, session_id: str, expected_generation: int) -> bool:
        if self.peer is not None and not self.started:
            if self.replaces:
                stored = generation_of(await self.load(session_id))
                assert await super().delete(session_id, stored)
            self.started.append(
                await self.peer.submit(
                    "late", _run_forever, "/", session_id=session_id
                )
            )
        return await super().delete(session_id, expected_generation)


@pytest.mark.asyncio
@pytest.mark.parametrize("replaces", [False, True])
async def test_a_close_stops_a_job_started_while_it_closed(replaces):
    store = _StartsOnDelete(replaces)
    a, b = JobTable(store), JobTable(store)
    store.peer = b
    await a.submit("sleep 30", _run_forever, "/", session_id="s")
    stopped = await a.close_session("s")
    [late] = store.started
    assert [j.command for j in stopped] == ["sleep 30", "late"]
    assert late.process is not None
    async with asyncio.timeout(2):
        await late.process.join()
    assert (late.status, late.exit_code) == (JobStatus.KILLED, 137)
    assert await store.load("s") is None


@pytest.mark.asyncio
async def test_a_job_whose_list_was_deleted_elsewhere_stops(monkeypatch):
    monkeypatch.setattr(
        "mirage.shell.job_table.table.LIST_CHECK_SECONDS", 0.02
    )
    store = RAMJobStore()
    table = JobTable(store)
    job = await table.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0)
    await store.clear()
    assert job.process is not None
    async with asyncio.timeout(2):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 137)


@pytest.mark.asyncio
async def test_a_listed_or_disowned_job_runs_on_past_its_checks(monkeypatch):
    monkeypatch.setattr(
        "mirage.shell.job_table.table.LIST_CHECK_SECONDS", 0.02
    )
    table = JobTable(RAMJobStore())
    listed = await table.submit("one", _run_forever, "/", session_id="s")
    disowned = await table.submit("two", _run_forever, "/", session_id="s")
    assert await table.disown(disowned.id, "s")
    await asyncio.sleep(0.1)
    assert [listed.status, disowned.status] == [JobStatus.RUNNING] * 2
    await table.kill_all()


@pytest.mark.asyncio
async def test_a_dropped_job_deaf_to_its_stop_still_ends(monkeypatch):
    monkeypatch.setattr(
        "mirage.shell.job_table.table.LIST_CHECK_SECONDS", 0.02
    )
    monkeypatch.setattr("mirage.shell.job_table.table.STOP_WAIT_SECONDS", 0.05)
    store = RAMJobStore()
    table = JobTable(store)
    release = asyncio.Event()

    async def deaf(job: Job) -> tuple[IOResult, ExecutionNode]:
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                continue
        return IOResult(), ExecutionNode()

    job = await table.submit("deaf", deaf, "/", session_id="s")
    await asyncio.sleep(0)
    await store.clear()
    async with asyncio.timeout(2):
        ended = await table.wait(job.id, "s")
    assert (ended.status, ended.exit_code) == (JobStatus.KILLED, 137)
    release.set()
    assert job.process is not None
    await job.process.join()


class _FailsReads(_FailsFirstWatch):
    """A console whose reads fail while its store counts failures down."""

    def __init__(self, inner: ConsoleStore, store: "_FailingReads") -> None:
        super().__init__(inner)
        self._failed = True
        self._store = store

    async def read_from(
        self, seq: int, limit: int | None = None
    ) -> ReadResult:
        if self._store.failures > 0:
            self._store.failures -= 1
            raise ConnectionError("connection dropped")
        return await super().read_from(seq, limit)


class _FailingReads(RAMJobStore):
    """A job store whose consoles fail its next ``failures`` reads."""

    def __init__(self) -> None:
        super().__init__()
        self.failures = 0

    def console(self, name: str) -> ConsoleStore:
        return _FailsReads(super().console(name), self)


@pytest.mark.asyncio
async def test_a_list_check_that_failed_a_read_checks_again(monkeypatch):
    monkeypatch.setattr(
        "mirage.shell.job_table.table.LIST_CHECK_SECONDS", 0.02
    )
    store = _FailingReads()
    table = JobTable(store)
    job = await table.submit("sleep 30", _run_forever, "/", session_id="s")
    await asyncio.sleep(0)
    store.failures = 1
    await store.clear()
    assert job.process is not None
    async with asyncio.timeout(2):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 137)
    assert store.failures == 0


def _publishing(store: RAMJobStore) -> JobTable:
    """A table whose processes are published on ``store``, as a
    workspace's are.

    Args:
        store (RAMJobStore): the shared store.
    """
    processes = ProcessTable(changed=lambda: table.processes_changed())
    table = JobTable(store, processes)
    return table


async def _until(check: Callable[[], Awaitable[bool]]) -> None:
    """Poll ``check`` until it holds, for at most five seconds.

    Args:
        check (Callable[[], Awaitable[bool]]): the condition.
    """
    async with asyncio.timeout(5):
        while not await check():
            await asyncio.sleep(0.01)


# A table on a shared store publishes the processes it runs while it runs
# any, and its record goes once it runs none; another table lists them.
@pytest.mark.asyncio
async def test_a_table_publishes_its_processes_while_it_runs_any(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = RAMJobStore(lease_seconds=30.0)
    a, b = _publishing(store), _publishing(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")

    async def listed() -> bool:
        return a.owner in await b.remote_processes()

    await _until(listed)
    record = (await b.remote_processes())[a.owner][str(job.pid)]
    assert (record["command"], record["session"], record["runs"]) == (
        "sleep 30",
        "s",
        [],
    )
    assert await a.remote_processes() == {}
    assert await a.kill(job.id, "s")

    async def dropped() -> bool:
        return await store.processes() == {}

    await _until(dropped)
    await a.close()
    await b.close()


# A stop another table asks of a process reaches its owner, which stops
# it as kill does: a job's runner ends the job killed by that signal.
@pytest.mark.asyncio
async def test_a_stop_asked_elsewhere_stops_the_owners_job(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = RAMJobStore(lease_seconds=30.0)
    a, b = _publishing(store), _publishing(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")

    async def listed() -> bool:
        return a.owner in await b.remote_processes()

    await _until(listed)
    every = ProcessPermissions(list="workspace", kill="workspace")
    assert await b.signal_remote(a.owner[:6], job.pid, 0, "t", every)
    assert job.status == JobStatus.RUNNING
    assert await b.signal_remote(a.owner[:6], job.pid, 15, "t", every)
    assert job.process is not None
    async with asyncio.timeout(5):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 143)
    assert not await b.signal_remote("ffffffff", job.pid, 15, "t", every)
    await a.close()
    await b.close()


# Another table's process is seen and stopped within the session's view:
# one another session runs is not found, or not permitted to stop.
@pytest.mark.asyncio
async def test_a_remote_signal_keeps_to_the_sessions_view(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = RAMJobStore(lease_seconds=30.0)
    a, b = _publishing(store), _publishing(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")

    async def listed() -> bool:
        return a.owner in await b.remote_processes()

    await _until(listed)
    own = ProcessPermissions()
    seen = ProcessPermissions(list="workspace", kill="session")
    assert not await b.signal_remote(a.owner, job.pid, 15, "t", own)
    with pytest.raises(PermissionError):
        await b.signal_remote(a.owner, job.pid, 15, "t", seen)
    assert await b.signal_remote(a.owner, job.pid, 15, "s", own)
    await a.close()
    await b.close()


# A lapsed owner's processes are not listed; the native runs it left are
# handed to the reaper, and its record keeps only the runs nobody here
# reached.
@pytest.mark.asyncio
@pytest.mark.parametrize("unreached", [False, True])
async def test_a_lapsed_owners_runs_are_reaped(unreached):
    store = RAMJobStore(lease_seconds=30.0)
    host = {"host": "h", "pid": 41, "started_at": 1.0, "command": "x"}
    box = {"runtime": "docker", "tag": "t", "command": "y"}
    await store.publish(
        "dead",
        {
            "2": {"pid": 2, "session": "s", "runs": [host]},
            "3": {"pid": 3, "session": "s", "runs": [box]},
        },
    )
    reaped: list[tuple[list, int]] = []

    async def reaper(runs: list, signum: int) -> list:
        reaped.append((runs, signum))
        return [run for run in runs if unreached and run == box]

    b = JobTable(store)
    b.reaper = reaper
    assert await b.remote_processes() == {}
    async with asyncio.timeout(5):
        while b._reaping:
            await asyncio.sleep(0.01)
    assert reaped == [([host], 15), ([box], 15)]
    kept = await store.processes()
    if unreached:
        assert kept == {
            "dead": {"3": {"pid": 3, "session": "s", "runs": [box]}}
        }
    else:
        assert kept == {}
    await b.close()


# A table that closes drops its record, so it never reads as lapsed.
@pytest.mark.asyncio
async def test_a_closed_table_drops_its_record():
    store = RAMJobStore(lease_seconds=30.0)
    a = JobTable(store)
    await store.publish(a.owner, {"2": {"pid": 2, "runs": []}})
    await a.close()
    assert await store.processes() == {}


async def _forever() -> int:
    """A process body that never finishes on its own."""
    await asyncio.Event().wait()
    return 0


class _VouchedStore(RAMJobStore):
    """A store that notes, at every write of a non-empty record, whether
    the owner's lease vouched for it."""

    def __init__(self) -> None:
        super().__init__(lease_seconds=30.0)
        self.vouched: list[bool] = []

    async def publish(self, owner, processes) -> None:
        if processes:
            self.vouched.append(await self.alive(owner))
        await super().publish(owner, processes)


# The lease goes ahead of the record it vouches for, so no workspace ever
# reads a record whose owner it takes for lapsed, even for a process that
# is no job (a line, a spawned child) and so renewed nothing first; and
# the record is written again with every renewal, so it outlives its
# store's expiry and comes back after a workspace dropped it.
@pytest.mark.asyncio
async def test_a_record_is_vouched_for_and_written_again(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = _VouchedStore()
    store.lease_seconds = 0.03
    a = _publishing(store)
    runner = a.processes.start(
        session_id="s",
        command="sleep 30",
        cwd=PathSpec.from_str_path("/"),
        run=_forever,
    )

    async def written_again() -> bool:
        return len(store.vouched) >= 3

    await _until(written_again)
    await RAMJobStore.publish(store, a.owner, {})

    async def back() -> bool:
        return a.owner in await store.processes()

    await _until(back)
    assert all(store.vouched)
    runner.terminate()
    await runner.join()
    await a.close()


class _Revives(RAMJobStore):
    """A store whose one owner reads as lapsed once, then as renewed."""

    def __init__(self) -> None:
        super().__init__(lease_seconds=30.0)
        self.asked = 0

    async def alive(self, owner: str) -> bool:
        self.asked += 1
        return self.asked > 1


# An owner that renews while its runs are being reaped keeps them: the
# lease is read again before each run is stopped.
@pytest.mark.asyncio
async def test_an_owner_that_renews_keeps_its_runs():
    store = _Revives()
    run = {"runtime": "docker", "tag": "t", "command": "x"}
    await store.publish(
        "back", {"2": {"pid": 2, "session": "s", "runs": [run]}}
    )
    reaped: list[list] = []

    async def reaper(runs: list, signum: int) -> list:
        reaped.append(runs)
        return []

    b = JobTable(store)
    b.reaper = reaper
    assert await b.remote_processes() == {}
    async with asyncio.timeout(5):
        while b._reaping:
            await asyncio.sleep(0.01)
    assert reaped == []
    assert "back" in await store.processes()
    await b.close()


# Teardown stops the reaping, before the runtimes it goes through close:
# a reap under way is cancelled and no listing starts another.
@pytest.mark.asyncio
async def test_teardown_stops_the_reaping():
    store = RAMJobStore(lease_seconds=30.0)
    run = {"runtime": "docker", "tag": "t", "command": "x"}
    await store.publish(
        "dead", {"2": {"pid": 2, "session": "s", "runs": [run]}}
    )
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def reaper(runs: list, signum: int) -> list:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return []

    b = JobTable(store)
    b.reaper = reaper
    await b.remote_processes()
    await asyncio.wait_for(started.wait(), 5)
    await b.kill_all()
    assert cancelled.is_set() and not b._reaping
    b._reaped.clear()
    await b.remote_processes()
    assert not b._reaping
    await b.close()


# A stop that fails to apply leaves the others it came with to be applied.
@pytest.mark.asyncio
async def test_one_failed_stop_leaves_the_others(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = RAMJobStore(lease_seconds=30.0)
    a = _publishing(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    applied: list[int] = []
    stop = a._stop_asked

    async def stopping(pid: int, signal: int) -> None:
        if pid == 999:
            raise RuntimeError("cannot stop")
        applied.append(pid)
        await stop(pid, signal)

    monkeypatch.setattr(a, "_stop_asked", stopping)
    await store.request_stop(a.owner, 999, 15)
    await store.request_stop(a.owner, job.pid, 15)
    assert job.process is not None
    async with asyncio.timeout(5):
        await job.process.join()
    assert applied == [job.pid]
    await a.close()


# A child shell's table keeps its job list private but reaches the other
# workspaces' processes through the workspace's.
@pytest.mark.asyncio
async def test_a_child_shells_table_reaches_the_process_plane(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = RAMJobStore(lease_seconds=30.0)
    a, b = _publishing(store), _publishing(store)
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    child = b.child().child()

    async def listed() -> bool:
        return a.owner in await child.remote_processes()

    await _until(listed)
    every = ProcessPermissions(list="workspace", kill="workspace")
    assert await child.signal_remote(a.owner, job.pid, 15, "s", every)
    assert job.process is not None
    async with asyncio.timeout(5):
        await job.process.join()
    await a.close()
    await b.close()


# The lease of a workspace that runs only processes, no job, is kept on
# the table's own renewal timer while they run, whatever a publish round
# costs, and dropped once the publishing stops.
@pytest.mark.asyncio
async def test_a_plain_process_holds_the_lease_while_it_runs(monkeypatch):
    monkeypatch.setattr(table_module, "PUBLISH_SECONDS", 0.01)
    store = RAMJobStore(lease_seconds=30.0)
    a = _publishing(store)
    runner = a.processes.start(
        session_id="s",
        command="sleep 30",
        cwd=PathSpec.from_str_path("/"),
        run=_forever,
    )

    async def leased() -> bool:
        return a._lease is not None and await store.alive(a.owner)

    await _until(leased)
    runner.terminate()
    await runner.join()

    async def dropped() -> bool:
        return a._lease is None

    await _until(dropped)
    await a.close()
