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
import contextlib
import uuid
from collections.abc import AsyncIterator, Callable

import pytest
import pytest_asyncio

from mirage.execution.constants import HISTORY_MAX_RECORDS, HISTORY_SECONDS
from mirage.execution.job.handle import JobHandle
from mirage.execution.job.table import JobTable
from mirage.execution.job.types import JobState
from mirage.execution.line.types import Line, LineState
from mirage.execution.process.types import Process, ProcessState
from mirage.execution.sql import SqlExecutionStore
from mirage.execution.types import LineId, MachineId, MachinePid, ProcessId
from mirage.io import IOResult
from mirage.shell.console import Channel
from mirage.types import PathSpec
from mirage.vfs.sql.driver import SqliteDriver
from mirage.vfs.sql.postgres import PostgresSqlDriver
from mirage.vfs.sql.types import SqlDriver
from mirage.workspace.types import ExecutionNode
from tests.fixtures.postgres import ON_POSTGRES, fresh_database

Open = Callable[..., SqlExecutionStore]


@pytest_asyncio.fixture(params=["sqlite", ON_POSTGRES])
async def stores(request, tmp_path) -> AsyncIterator[Open]:
    scope = f"test/{uuid.uuid4().hex}/"
    drivers: list[SqlDriver] = []
    opened: list[SqlExecutionStore] = []
    database = contextlib.ExitStack()
    dsn = (
        database.enter_context(fresh_database())
        if request.param == "postgres"
        else ""
    )

    def open_store(lease_seconds: float | None = 30.0) -> SqlExecutionStore:
        driver: SqlDriver = (
            SqliteDriver(str(tmp_path / "execution.db"))
            if request.param == "sqlite"
            else PostgresSqlDriver(dsn)
        )
        drivers.append(driver)
        store = SqlExecutionStore(driver, scope, lease_seconds=lease_seconds)
        opened.append(store)
        return store

    yield open_store
    for store in opened:
        await store.close()
    for driver in drivers:
        driver.close()
    database.close()


async def _run_forever(job: JobHandle) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (JobHandle): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


def _line(n: int, ended_at: float | None = None) -> Line:
    return Line(
        LineId(f"line_{n}"),
        "s",
        f"echo {n}",
        float(n),
        LineState.EXITED if ended_at is not None else LineState.RUNNING,
        ended_at,
        0 if ended_at is not None else None,
    )


@pytest.mark.asyncio
async def test_a_list_is_written_under_its_generation(stores):
    store = stores()
    assert await store.load("s") is None
    assert await store.cas_set("s", {"next": 2, "generation": 1}, 0)
    assert not await store.cas_set("s", {"next": 3, "generation": 1}, 0)
    assert await store.load("s") == {"next": 2, "generation": 1}
    assert await store.sessions() == ["s"]
    assert await store.cas_set("s", {"next": 3, "generation": 2}, 1)
    assert not await store.cas_set("s", {"next": 4, "generation": 3}, 1)
    assert not await store.delete("s", 0)
    assert await store.load("s") == {"next": 3, "generation": 2}
    assert await store.delete("s", 2)
    assert await store.load("s") is None
    assert await store.delete("s", 0)


# A console is one stream every store on the database reaches by name; a
# reader waiting on another store wakes once a chunk or the ending lands,
# and nothing is appended past the ending.
@pytest.mark.asyncio
async def test_a_console_reaches_every_store_and_ends_once(stores):
    first, second = stores(), stores()
    writer, reader = first.console("c"), second.console("c")
    waiting = asyncio.ensure_future(reader.wait(1))
    assert (await writer.append(Channel.STDOUT, b"hi")).seq == 0
    assert (await writer.append(Channel.STDERR, b"oops")).seq == 1
    async with asyncio.timeout(5):
        await waiting
    chunks, cursor, dropped = await reader.read_from(0)
    assert [(c.channel, c.data) for c in chunks] == [
        (Channel.STDOUT, b"hi"),
        (Channel.STDERR, b"oops"),
    ]
    assert (cursor, dropped) == (2, False)
    assert [c.data for c in (await reader.read_from(1, 1))[0]] == [b"oops"]
    ended = asyncio.ensure_future(writer.wait_ended())
    await reader.append(Channel.CONTROL, b"exit:0")
    async with asyncio.timeout(5):
        await ended
    late = await writer.append(Channel.STDOUT, b"late")
    assert (late.seq, late.channel) == (2, Channel.CONTROL)
    assert len((await reader.read_from(0))[0]) == 3


# A console goes once no job list names it.
@pytest.mark.asyncio
async def test_a_console_is_dropped_once_no_list_names_it(stores):
    store = stores()
    await store.console("c").append(Channel.STDOUT, b"x")
    listed = {"jobs": {"1": {"console": "c"}}, "generation": 1}
    assert await store.cas_set("s", listed, 0)
    assert await store.cas_set("s", {"jobs": {}, "generation": 2}, 1)
    assert (await stores().console("c").read_from(0))[0] == []


@pytest.mark.asyncio
async def test_one_daemon_holds_the_lease_while_it_renews(stores):
    a, b = stores(lease_seconds=0.2), stores(lease_seconds=0.2)
    assert await a.holder() is None
    assert await a.lease("a") is None
    assert await b.lease("b") == "a"
    assert await b.holder() == "a"
    await b.release("b")
    assert await a.lease("a") is None
    await asyncio.sleep(0.3)
    assert await b.holder() is None
    assert await b.lease("b") is None
    assert await a.lease("a") == "b"
    await b.release("b")
    assert await a.holder() is None


@pytest.mark.asyncio
async def test_a_daemons_processes_reach_every_store_and_go(stores):
    a, b = stores(), stores()
    record = {"pid": 2, "command": "sleep 30"}
    await a.publish("a", {"2": record}, 2)
    assert await b.processes() == {"a": {"2": record}}
    await b.request_stop("a", 2, 15)
    await b.request_stop("a", 3, 9)
    assert await a.take_stops("a") == [(2, 15), (3, 9)]
    assert await a.take_stops("a") == []
    await a.publish("a", {})
    assert await b.processes() == {}


@pytest.mark.asyncio
async def test_the_highest_pid_only_rises_on_every_store(stores):
    a, b = stores(), stores()
    assert await b.highest_pid() == 0
    await a.publish("a", {}, 7)
    await b.publish("b", {}, 3)
    assert await a.highest_pid() == 7
    assert await b.highest_pid() == 7


@pytest.mark.asyncio
async def test_a_table_on_another_store_kills_and_waits_on_a_job(stores):
    a, b = JobTable(stores()), JobTable(stores())
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await b.sync("s")
    assert [j.state for j in b.list_jobs("s")] == [JobState.RUNNING]
    assert await b.kill(1, "s", 15)
    assert (await b.wait(1, "s")).exit_code == 143
    assert job.process is not None
    async with asyncio.timeout(5):
        await job.process.join()
    assert (job.signal, job.exit_code) == (15, 143)
    await a.close()


# A record noted on one store reaches every store on the database once it
# is written, the newest of each winning, with every field it was noted
# with.
@pytest.mark.asyncio
async def test_a_noted_record_reaches_every_store(stores):
    a, b = stores(), stores()
    process = Process(
        id=ProcessId("w", 7),
        session_id="s",
        line=LineId("line_1"),
        parent=3,
        group=3,
        command="sleep 30",
        cwd=PathSpec.from_str_path("/m"),
        machine=MachineId("docker", "tools"),
        started_at=1.5,
        runtime="docker",
        machine_pid=MachinePid(4242, 1.25),
        state=ProcessState.STOPPING,
        ancestors=(1, 3),
        machine_instance="tools-1",
    )
    a.note(_line(1))
    a.note(_line(1, ended_at=2.0))
    a.note(process)
    assert await a.get_line(LineId("line_1")) == _line(1, ended_at=2.0)
    async with asyncio.timeout(5):
        while not await b.find_processes():
            await asyncio.sleep(0.01)
    assert await b.get_process(ProcessId("w", 7)) == process
    assert await b.find_lines() == [_line(1, ended_at=2.0)]
    assert await b.find_lines("other") == []


# Ended records are kept to the history: the newest HISTORY_MAX_RECORDS of
# a kind, ended within HISTORY_SECONDS of the newest; a running one stays.
@pytest.mark.asyncio
async def test_ended_records_are_kept_to_the_history(stores):
    a, b = stores(), stores()
    a.note(_line(0))
    for n in range(1, HISTORY_MAX_RECORDS + 3):
        a.note(_line(n, ended_at=float(n)))
    newest = f"line_{HISTORY_MAX_RECORDS + 2}"
    async with asyncio.timeout(10):
        while newest not in [r.id.value for r in await b.find_lines()]:
            await asyncio.sleep(0.01)
    kept = [r.id.value for r in await b.find_lines()]
    assert len(kept) == HISTORY_MAX_RECORDS + 1
    assert kept[:2] == ["line_0", "line_3"]
    a.note(_line(5000, ended_at=HISTORY_SECONDS + 1000.5))
    async with asyncio.timeout(10):
        while "line_5000" not in [r.id.value for r in await b.find_lines()]:
            await asyncio.sleep(0.01)
    kept = [r.id.value for r in await b.find_lines()]
    assert kept[:3] == ["line_0", "line_1001", "line_1002"]
    assert len(kept) == 28


@pytest.mark.asyncio
async def test_clear_drops_lists_consoles_records_and_the_lease(stores):
    store = stores()
    await store.cas_set("s", {"generation": 1}, 0)
    await store.console("c").append(Channel.STDOUT, b"x")
    await store.lease("o")
    await store.publish("o", {"1": {}}, 4)
    store.note(_line(1))
    await store.clear()
    other = stores()
    assert await other.load("s") is None
    assert (await other.console("c").read_from(0))[0] == []
    assert await other.holder() is None
    assert await other.processes() == {}
    assert await other.highest_pid() == 0
    assert await other.find_lines() == []
