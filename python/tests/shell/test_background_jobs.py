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

from mirage.io.types import IOResult
from mirage.resource.ram import RAMResource
from mirage.shell.console import Channel
from mirage.shell.job_table import JobStatus, JobTable
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.types import ExecutionNode


async def _failing_run(job):
    raise RuntimeError("resource API error")


async def _successful_run(job):
    await job.console.emit(Channel.STDOUT, b"hello")
    return IOResult(exit_code=0), ExecutionNode(command="echo hello",
                                                exit_code=0)


async def _never_ending_run(job):
    await job.console.emit(Channel.STDOUT, b"partial")
    await asyncio.sleep(30)
    return IOResult(exit_code=0), ExecutionNode(command="noisy", exit_code=0)


_DEAF_RELEASE: list[asyncio.Event] = []


async def _deaf_run(job):
    """A runner that does not die on the first cancel.

    Models a command with cleanup of its own: cancellation is delivered,
    swallowed, and the runner keeps going, so nothing settles the job
    unless ``kill`` settles it.
    """
    await job.console.emit(Channel.STDOUT, b"partial")
    release = asyncio.Event()
    _DEAF_RELEASE.append(release)
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError:
        await release.wait()
    return IOResult(exit_code=0), ExecutionNode(command="deaf", exit_code=0)


def test_kill_settles_a_runner_that_ignores_the_cancel():
    """kill must not join a runner that may never notice it was cancelled."""

    async def _run():
        _DEAF_RELEASE.clear()
        table = JobTable()
        job = table.submit(command="deaf", run=_deaf_run, cwd="/")
        while not await job.console.snapshot(Channel.STDOUT):
            await asyncio.sleep(0)

        # Joining here would hang on exactly the job being stopped.
        assert await asyncio.wait_for(table.kill(1), timeout=5)

        assert job.status == JobStatus.KILLED
        assert job.exit_code == 137
        assert job.console.finished

        # The runner finishes normally afterwards; it must not relabel
        # the job it no longer owns.
        while not _DEAF_RELEASE:
            await asyncio.sleep(0)
        _DEAF_RELEASE[0].set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert job.status == JobStatus.KILLED
        assert job.exit_code == 137

    asyncio.run(_run())


def test_wait_handles_task_exception():

    async def _run():
        table = JobTable()
        table.submit(command="bad_cmd", run=_failing_run, cwd="/")
        job = await table.wait(1)
        assert job.status == JobStatus.COMPLETED
        assert job.exit_code == 1
        stderr = await job.console.snapshot(Channel.STDERR)
        assert b"resource API error" in stderr

    asyncio.run(_run())


def test_wait_all_survives_failing_task():

    async def _run():
        table = JobTable()
        table.submit(command="bad", run=_failing_run, cwd="/")
        table.submit(command="good", run=_successful_run, cwd="/")
        jobs = await table.wait_all()
        assert len(jobs) == 2
        bad = table.get(1)
        good = table.get(2)
        assert bad.exit_code == 1
        assert good.exit_code == 0
        assert await good.console.snapshot(Channel.STDOUT) == b"hello"

    asyncio.run(_run())


def test_wait_successful_task():

    async def _run():
        table = JobTable()
        table.submit(command="echo hello", run=_successful_run, cwd="/")
        job = await table.wait(1)
        assert job.status == JobStatus.COMPLETED
        assert job.exit_code == 0
        assert await job.console.snapshot(Channel.STDOUT) == b"hello"

    asyncio.run(_run())


def test_kill_keeps_output_produced_before_the_kill():

    async def _run():
        table = JobTable()
        job = table.submit(command="noisy", run=_never_ending_run, cwd="/")
        while not await job.console.snapshot(Channel.STDOUT):
            await asyncio.sleep(0)

        assert await table.kill(1)

        assert job.status == JobStatus.KILLED
        assert job.exit_code == 137
        assert await job.console.snapshot(Channel.STDOUT) == b"partial"
        assert await job.console.snapshot(Channel.STDERR) == b"Killed"

    asyncio.run(_run())


def test_kill_returns_a_settled_job():
    """kill joins, so a caller never sees a half-dead job."""

    async def _run():
        table = JobTable()
        job = table.submit(command="noisy", run=_never_ending_run, cwd="/")

        assert await table.kill(1)

        assert job.console.finished
        assert job.status == JobStatus.KILLED

    asyncio.run(_run())


def test_kill_is_false_for_unknown_and_finished_jobs():

    async def _run():
        table = JobTable()
        table.submit(command="echo hello", run=_successful_run, cwd="/")
        await table.wait(1)

        assert not await table.kill(1)
        assert not await table.kill(404)

    asyncio.run(_run())


def test_kill_all_stops_every_running_job():

    async def _run():
        table = JobTable()
        table.submit(command="a", run=_never_ending_run, cwd="/")
        table.submit(command="b", run=_never_ending_run, cwd="/")

        killed = await table.kill_all()

        assert len(killed) == 2
        assert table.running_jobs() == []

    asyncio.run(_run())


def test_background_does_not_consume_stdin():

    async def _run():
        mem = RAMResource()
        ws = Workspace(
            {"/data": (mem, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        ws.get_session(ws.default_session_id).cwd = "/data"
        io = await ws.execute("sleep 0 & cat", stdin=b"hello\n")
        assert (await io.stdout_str()).strip() == "hello"

    asyncio.run(_run())
