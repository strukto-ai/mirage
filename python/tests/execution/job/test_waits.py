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

from mirage.execution.job import JobTable, JobWaits
from mirage.execution.job.waits import Hold
from mirage.io import IOResult
from mirage.shell.console import Channel, JobConsole, JobOutput
from mirage.workspace.types import ExecutionNode


@pytest.mark.asyncio
async def test_join_outlasts_every_job_including_ones_added_meanwhile():
    table = JobTable()
    waits = JobWaits(JobOutput(JobConsole()))
    gate = asyncio.Event()
    finished: list[str] = []

    async def late(job):
        await gate.wait()
        finished.append("late")
        return IOResult(), ExecutionNode(command="late", exit_code=0)

    async def first(job):
        waits.add(
            (await table.submit("late", late, cwd="/")).console.wait_finished,
            frozenset({"&1"}),
        )
        finished.append("first")
        return IOResult(), ExecutionNode(command="first", exit_code=0)

    waits.add(
        (await table.submit("first", first, cwd="/")).console.wait_finished,
        frozenset({"&1"}),
    )
    joined = asyncio.create_task(waits.join(JobConsole()))
    await asyncio.sleep(0.01)
    assert not joined.done()
    gate.set()
    await asyncio.wait_for(joined, 5)
    assert finished == ["first", "late"]


def test_a_job_counts_only_through_a_stream_the_capture_reads():
    capture = JobOutput(JobConsole())
    waits = JobWaits(capture)
    assert waits.reaches(capture, {Channel.STDOUT})
    assert not waits.reaches(capture, {Channel.STDERR})
    assert waits.reaches(JobOutput(capture), {Channel.STDOUT})
    assert JobWaits(capture, frozenset({Channel.STDERR})).reaches(
        capture, {Channel.STDERR}
    )


@pytest.mark.asyncio
async def test_what_the_other_jobs_write_goes_to_the_caller_once_it_ends():
    capture = JobOutput(JobConsole())
    rest = JobConsole()
    await JobWaits(capture).join(rest)
    await capture.emit(Channel.STDERR, b"late")
    assert await rest.snapshot(Channel.STDERR) == b"late"


@pytest.mark.asyncio
async def test_join_lets_go_of_a_child_that_closed_what_led_into_it():
    waits = JobWaits(JobOutput(JobConsole()))
    never = asyncio.Event()
    hold = waits.add(never.wait, frozenset({"&1"}))
    joined = asyncio.create_task(waits.join(JobConsole()))
    hold.settle({"&1", "&2"})
    await asyncio.sleep(0.01)
    assert not joined.done()
    hold.settle({"/dev/null", "&2"})
    await asyncio.wait_for(joined, 5)


def test_a_hold_stays_while_a_copy_still_names_the_stream():
    hold = Hold(frozenset({"&1"}))
    hold.settle({"/dev/null", "&2", "&1"})
    assert not hold.released.is_set()


@pytest.mark.asyncio
async def test_join_fails_when_waiting_for_a_child_fails():
    waits = JobWaits(JobOutput(JobConsole()))

    async def broken() -> None:
        raise ConnectionError("store lost")

    waits.add(broken, frozenset({"&1"}))
    with pytest.raises(ConnectionError):
        await asyncio.wait_for(waits.join(JobConsole()), 5)
