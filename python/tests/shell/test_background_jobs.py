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
from mirage.shell.job_table import JobStatus, JobTable
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.types import ExecutionNode


async def _make_failing_task():
    raise RuntimeError("resource API error")


async def _make_successful_task():
    return b"hello", IOResult(exit_code=0), ExecutionNode(command="echo hello",
                                                          exit_code=0)


def test_wait_handles_task_exception():

    async def _run():
        table = JobTable()
        task = asyncio.create_task(_make_failing_task())
        table.submit(command="bad_cmd", task=task, cwd="/")
        job = await table.wait(1)
        assert job.status == JobStatus.COMPLETED
        assert job.exit_code == 1
        assert b"resource API error" in job.stderr

    asyncio.run(_run())


def test_wait_all_survives_failing_task():

    async def _run():
        table = JobTable()
        task1 = asyncio.create_task(_make_failing_task())
        task2 = asyncio.create_task(_make_successful_task())
        table.submit(command="bad", task=task1, cwd="/")
        table.submit(command="good", task=task2, cwd="/")
        jobs = await table.wait_all()
        assert len(jobs) == 2
        bad = table.get(1)
        good = table.get(2)
        assert bad.exit_code == 1
        assert good.exit_code == 0
        assert good.stdout == b"hello"

    asyncio.run(_run())


def test_wait_successful_task():

    async def _run():
        table = JobTable()
        task = asyncio.create_task(_make_successful_task())
        table.submit(command="echo hello", task=task, cwd="/")
        job = await table.wait(1)
        assert job.status == JobStatus.COMPLETED
        assert job.exit_code == 0
        assert job.stdout == b"hello"

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
