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

from mirage.execution.constants import HISTORY_MAX_RECORDS, HISTORY_SECONDS
from mirage.execution.line.types import Line, LineState
from mirage.execution.process.types import Process
from mirage.execution.ram import RAMExecutionStore
from mirage.execution.types import LineId, MachineId, ProcessId
from mirage.shell.console import Channel
from mirage.types import PathSpec
from mirage.workspace.record.types import generation_of


def _list(*names: str, generation: int = 1) -> dict:
    return {
        "next": len(names) + 1,
        "jobs": {str(i + 1): {"console": n} for i, n in enumerate(names)},
        "generation": generation,
    }


@pytest.mark.asyncio
async def test_a_list_is_written_under_its_generation():
    store = RAMExecutionStore()
    assert await store.load("s") is None
    assert await store.cas_set("s", _list("a"), 0)
    assert not await store.cas_set("s", _list("a", "b"), 0)
    assert await store.cas_set("s", _list("a", "b", generation=2), 1)
    stored = await store.load("s")
    assert stored is not None
    assert list(stored["jobs"]) == ["1", "2"]
    assert not await store.delete("s", 1)
    assert await store.load("s") is not None
    assert await store.delete("s", 2)
    assert await store.load("s") is None


@pytest.mark.asyncio
async def test_a_loaded_list_is_a_copy():
    store = RAMExecutionStore()
    await store.cas_set("s", _list("a"), 0)
    loaded = await store.load("s")
    assert loaded is not None
    loaded["jobs"].clear()
    stored = await store.load("s")
    assert stored is not None
    assert list(stored["jobs"]) == ["1"]


@pytest.mark.asyncio
async def test_a_console_is_dropped_once_no_list_names_it():
    store = RAMExecutionStore()
    await store.cas_set("s", _list("a"), 0)
    held = store.console("a")
    await held.append(Channel.STDOUT, b"kept")
    assert store.console("a") is held
    await store.cas_set("s", _list(generation=2), 1)
    assert store.console("a") is not held
    chunks, _, _ = await held.read_from(0)
    assert [c.data for c in chunks] == [b"kept"]


@pytest.mark.asyncio
async def test_one_daemon_holds_the_lease_until_it_releases_it():
    store = RAMExecutionStore()
    assert await store.holder() is None
    assert await store.lease("a") is None
    assert await store.lease("a") is None
    assert await store.lease("b") == "a"
    assert await store.holder() == "a"
    await store.release("b")
    assert await store.holder() == "a"
    await store.release("a")
    assert await store.lease("b") is None
    assert await store.holder() == "b"


@pytest.mark.asyncio
async def test_a_lease_lapses_unless_renewed():
    store = RAMExecutionStore(lease_seconds=0.05)
    assert await store.lease("a") is None
    assert await store.lease("b") == "a"
    await asyncio.sleep(0.1)
    assert await store.holder() is None
    assert await store.lease("b") is None


@pytest.mark.asyncio
async def test_a_daemons_processes_are_published_and_dropped():
    store = RAMExecutionStore()
    record = {"pid": 2, "command": "sleep 30", "runs": []}
    await store.publish("a", {"2": record}, 2)
    await store.publish("b", {"5": {"pid": 5, "runs": []}}, 5)
    found = await store.processes()
    assert found == {"a": {"2": record}, "b": {"5": {"pid": 5, "runs": []}}}
    found["a"]["2"]["pid"] = 9
    assert (await store.processes())["a"]["2"]["pid"] == 2
    await store.publish("a", {})
    assert list(await store.processes()) == ["b"]


@pytest.mark.asyncio
async def test_the_highest_pid_only_rises():
    store = RAMExecutionStore()
    assert await store.highest_pid() == 0
    await store.publish("a", {}, 7)
    await store.publish("b", {}, 3)
    assert await store.highest_pid() == 7


@pytest.mark.asyncio
async def test_stops_asked_of_a_daemon_are_taken_once():
    store = RAMExecutionStore()
    await store.request_stop("a", 2, 15)
    await store.request_stop("a", 3, 9)
    await store.request_stop("b", 4, 9)
    assert await store.take_stops("a") == [(2, 15), (3, 9)]
    assert await store.take_stops("a") == []
    assert await store.take_stops("b") == [(4, 9)]


def test_lists_written_from_many_threads_lose_no_write():
    store = RAMExecutionStore()

    async def bump(times: int) -> None:
        for _ in range(times):
            while True:
                fields = await store.load("s")
                count = fields["count"] if fields else 0
                generation = generation_of(fields)
                written = {"count": count + 1, "generation": generation + 1}
                if await store.cas_set("s", written, generation):
                    break

    threads = [
        threading.Thread(target=asyncio.run, args=(bump(200),))
        for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    stored = asyncio.run(store.load("s"))
    assert stored is not None
    assert stored["count"] == 800


def _line(n: int, session: str = "s", ended_at: float | None = None) -> Line:
    return Line(
        LineId(f"line_{n}"),
        session,
        f"echo {n}",
        float(n),
        LineState.EXITED if ended_at is not None else LineState.RUNNING,
        ended_at,
        0 if ended_at is not None else None,
    )


def _process(pid: int, session: str = "s") -> Process:
    return Process(
        id=ProcessId("w", pid),
        session_id=session,
        line=LineId("line_1"),
        parent=None,
        group=pid,
        command="sleep 30",
        cwd=PathSpec.from_str_path("/"),
        machine=MachineId("host", "box"),
        started_at=1.0,
    )


# A record noted again replaces the one before; lines list oldest first,
# processes by pid, each a session's when one is named.
@pytest.mark.asyncio
async def test_noted_records_are_found_by_id_and_session():
    store = RAMExecutionStore()
    assert await store.sessions() == []
    await store.cas_set("t", {"generation": 1}, 0)
    assert await store.sessions() == ["t"]
    store.note(_line(2))
    store.note(_line(1, session="t"))
    store.note(_line(2, ended_at=5.0))
    store.note(_process(9))
    store.note(_process(3, session="t"))
    assert [(r.id.value, r.state) for r in await store.find_lines()] == [
        ("line_1", LineState.RUNNING),
        ("line_2", LineState.EXITED),
    ]
    assert [r.id.value for r in await store.find_lines("t")] == ["line_1"]
    assert await store.get_line(LineId("line_2")) == _line(2, ended_at=5.0)
    assert await store.get_line(LineId("nope")) is None
    assert [r.pid for r in await store.find_processes()] == [3, 9]
    assert [r.pid for r in await store.find_processes("s")] == [9]
    assert await store.get_process(ProcessId("w", 9)) == _process(9)
    await store.clear()
    assert await store.find_lines() == []
    assert await store.find_processes() == []


# Ended records are kept to the history: the newest HISTORY_MAX_RECORDS of
# a kind, ended within HISTORY_SECONDS of the newest; a running one stays.
@pytest.mark.asyncio
async def test_ended_records_are_kept_to_the_history():
    store = RAMExecutionStore()
    store.note(_line(0))
    for n in range(1, HISTORY_MAX_RECORDS + 3):
        store.note(_line(n, ended_at=float(n)))
    kept = [r.id.value for r in await store.find_lines()]
    assert len(kept) == HISTORY_MAX_RECORDS + 1
    assert kept[:2] == ["line_0", "line_3"]
    store.note(_line(5000, ended_at=HISTORY_SECONDS + 1000.5))
    kept = [r.id.value for r in await store.find_lines()]
    assert kept[:3] == ["line_0", "line_1001", "line_1002"]
    assert kept[-1] == "line_5000"
    assert len(kept) == 28
