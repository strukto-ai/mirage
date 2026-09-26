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
from mirage.shell.console import Channel, JobConsole, RAMConsoleStore
from mirage.shell.console.types import ConsoleChunk, ReadResult
from mirage.shell.job_table.table import JobTable
from mirage.shell.job_table.types import Job, JobStatus
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

    async def read_from(self,
                        seq: int,
                        limit: int | None = None) -> ReadResult:
        return await self._inner.read_from(seq, limit)

    @property
    def closed(self) -> bool:
        return self._inner.closed

    async def wait(self, seq: int) -> None:
        await self._inner.wait(seq)

    async def close(self) -> None:
        await self._inner.close()


async def _run_forever(job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (Job): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


def _tracked_ram_console(stores: list[RAMConsoleStore],
                         job_id: int) -> JobConsole:
    """A console factory that remembers the stores it built.

    Args:
        stores (list[RAMConsoleStore]): where built stores are recorded.
        job_id (int): the job the console is being built for.
    """
    store = RAMConsoleStore()
    stores.append(store)
    return JobConsole(store=store)


def _submit_gated(table: JobTable, gate: asyncio.Event) -> Job:
    job = table.submit(command="deaf", run=_run_forever, cwd="/")
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
    job = _submit_gated(table, gate)
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
    job = _submit_gated(table, gate)
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
async def test_close_consoles_releases_factory_stores():
    """Teardown closes what the factory built, and only that."""
    stores: list[RAMConsoleStore] = []
    table = JobTable(console_factory=partial(_tracked_ram_console, stores))
    job = table.submit(command="deaf", run=_run_forever, cwd="/")
    await table.kill(job.id)
    await table.close_consoles()
    assert len(stores) == 1
    assert all(s.closed for s in stores)


@pytest.mark.asyncio
async def test_close_consoles_leaves_default_consoles_alone():
    table = JobTable()
    job = table.submit(command="deaf", run=_run_forever, cwd="/")
    await table.kill(job.id)
    await table.close_consoles()
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
    job = _submit_gated(table, gate)
    await asyncio.sleep(0)
    assert job.task is not None
    job.task.cancel()
    await asyncio.sleep(0.01)
    assert job.status is JobStatus.KILLED
    job.task.cancel()
    await asyncio.sleep(0.01)
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(job.task, 2)
    await asyncio.wait_for(job.console.wait_finished(), 2)
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


def _submit(table: JobTable, session_id: str, command: str = "x") -> Job:
    return table.submit(command=command,
                        run=_run_forever,
                        cwd="/",
                        session_id=session_id)


@pytest.mark.asyncio
async def test_each_session_numbers_its_jobs_from_one():
    table = JobTable()
    a1 = _submit(table, "a")
    b1 = _submit(table, "b")
    a2 = _submit(table, "a")
    assert (a1.id, b1.id, a2.id) == (1, 1, 2)
    await table.kill_all()


@pytest.mark.asyncio
async def test_views_are_scoped_to_one_session():
    table = JobTable()
    a1 = _submit(table, "a")
    b1 = _submit(table, "b")
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
    a1 = _submit(table, "a")
    b1 = _submit(table, "b")
    killed = await table.kill_all()
    assert {j.session_id for j in killed} == {"a", "b"}
    assert a1.status is JobStatus.KILLED
    assert b1.status is JobStatus.KILLED
    assert table.all_running_jobs() == []


@pytest.mark.asyncio
async def test_numbering_resets_per_session_when_its_list_empties():
    table = JobTable()
    a1 = _submit(table, "a")
    _submit(table, "b")
    assert await table.kill(a1.id, "a")
    table.reap(a1.id, "a")
    assert _submit(table, "a").id == 1
    assert _submit(table, "b").id == 2
    await table.kill_all()


@pytest.mark.asyncio
async def test_close_session_stops_and_forgets_its_jobs():
    table = JobTable()
    a1 = _submit(table, "a")
    a2 = _submit(table, "a")
    b1 = _submit(table, "b")
    assert table.disown(a2.id, "a")
    assert await table.close_session("a") == [a1]
    assert a1.status is JobStatus.KILLED
    # Disowned: off the list, still running, bash's own rule.
    assert a2.status is JobStatus.RUNNING
    assert table.list_jobs("a") == []
    assert table.get(1, "a") is None
    assert table.list_jobs("b") == [b1]
    # A session reusing the id starts from one and inherits nothing.
    assert _submit(table, "a").id == 1
    await table.kill_all()
    assert a2.status is JobStatus.KILLED


@pytest.mark.asyncio
async def test_load_restores_a_job_into_its_session():
    table = JobTable()
    restored = Job(id=3,
                   command="x",
                   task=None,
                   cwd="/",
                   status=JobStatus.COMPLETED,
                   session_id="a")
    table.load(restored)
    assert table.get(3, "a") is restored
    assert table.get(3) is None
    assert _submit(table, "a").id == 4
    assert _submit(table, "b").id == 1
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

    job = table.submit(command="long", run=run, cwd="/", session_id="a")
    await entered.wait()
    process = job.process
    assert process is not None
    view = table.processes.view("a")
    assert table.disown(job.id, "a")
    assert table.list_jobs("a") == []
    assert view.get(process.info.pid) is not None
    await table.kill_all()
    assert job.status == JobStatus.KILLED
    assert view.get(process.info.pid).state == "stopping"
    release.set()
    result = await process.join()
    assert result.exit_code == 0
    assert result.cancellation_requested
    assert view.list() == ()


@pytest.mark.asyncio
async def test_process_ids_do_not_restart_with_shell_job_numbers():
    table = JobTable()
    a = _submit(table, "a")
    b = _submit(table, "b")
    assert a.id == b.id == 1
    assert a.process.info.pid != b.process.info.pid
    await table.kill(a.id, "a")
    table.reap(a.id, "a")
    replacement = _submit(table, "a")
    assert replacement.id == 1
    assert replacement.process.info.pid > b.process.info.pid
    await table.kill_all()
    await asyncio.gather(a.process.join(), b.process.join(),
                         replacement.process.join())
