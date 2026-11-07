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

from mirage.execution.job import JobState, JobTable
from mirage.io import IOResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.wait.wait import handle_wait
from mirage.workspace.types import ExecutionNode
from tests.fixtures.job_runners import (
    submit_settled,
)


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)


def test_bare_wait_with_no_jobs_returns_nothing():
    async def _do():
        ws = _workspace()
        result = await ws.shell("wait")
        return await result.stdout_str(), result.exit_code

    out, code = asyncio.run(_do())
    assert out == ""
    assert code == 0


@pytest.mark.asyncio
async def test_wait_without_an_id_waits_for_every_job():
    table = JobTable()
    job = await submit_settled(table)
    _, io, node = await handle_wait(table, ["wait"])
    assert io.exit_code == 0
    assert node.command == "wait"
    # Bare `wait` adopts and reaps, so the table entry is gone but the
    # job object itself has settled.
    assert table.get(job.id) is None
    assert (job.state, job.signal) == (JobState.EXITED, None)


@pytest.mark.asyncio
async def test_wait_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "abc"])
    assert io.exit_code == 1
    assert b"not a pid or valid job spec" in io.stderr


@pytest.mark.asyncio
async def test_wait_rejects_an_unknown_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "999"])
    assert io.exit_code == 127
    assert b"not a child of this shell" in io.stderr


@pytest.mark.asyncio
async def test_wait_answers_the_awaited_jobs_status_and_prints_nothing():
    table = JobTable()
    job = await submit_settled(
        table, stdout=b"out", stderr=b"done", exit_code=3
    )
    stdout, io, _ = await handle_wait(table, ["wait", str(job.id)])
    assert stdout is None
    assert io.exit_code == 3
    assert io.stderr is None


@pytest.mark.asyncio
async def test_wait_accepts_the_percent_job_id_spelling():
    table = JobTable()
    job = await submit_settled(table)
    _, io, _ = await handle_wait(table, ["wait", f"%{job.id}"])
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_wait_n_returns_first_finisher():
    table = JobTable()

    async def _quick(job):
        return IOResult(exit_code=3), ExecutionNode(command="q", exit_code=3)

    await table.submit("q", _quick, cwd="/")
    _, io, _ = await handle_wait(table, ["wait", "-n"])
    assert io.exit_code == 3


@pytest.mark.asyncio
async def test_wait_n_with_no_jobs_is_127():
    _, io, _ = await handle_wait(JobTable(), ["wait", "-n"])
    assert io.exit_code == 127


@pytest.mark.asyncio
async def test_wait_bad_option():
    _, io, _ = await handle_wait(JobTable(), ["wait", "-x"])
    assert io.exit_code == 2
    assert b"invalid option" in io.stderr


@pytest.mark.asyncio
async def test_wait_p_with_no_operand_leaves_the_variable_unset():
    """The no-operand form waits for everything and reports no one job,
    so bash leaves the variable unset (having cleared it first)."""
    ws = Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('(exit 0) & V=stale; wait -p V; echo "V=[${V-UNSET}]"')
    assert (await io.stdout_str()) == "V=[UNSET]\n"
    await ws.close()
