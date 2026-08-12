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

from mirage.io import IOResult
from mirage.shell.job_table import JobStatus, JobTable
from mirage.workspace.executor.jobs import (handle_fg, handle_jobs,
                                            handle_kill, handle_ps,
                                            handle_wait)
from mirage.workspace.types import ExecutionNode


async def _settled(stdout=None, io=None):
    return stdout, io or IOResult(), ExecutionNode()


async def _forever():
    await asyncio.Event().wait()


def _submit_settled(table, command="foo", stdout=None, io=None):
    return table.submit(command=command,
                        task=asyncio.create_task(_settled(stdout, io)),
                        cwd="/")


def _submit_pending(table, command="sleep"):
    return table.submit(command=command,
                        task=asyncio.create_task(_forever()),
                        cwd="/")


@pytest.mark.asyncio
async def test_wait_without_an_id_waits_for_every_job():
    table = JobTable()
    job = _submit_settled(table)
    _, io, node = await handle_wait(table, ["wait"])
    assert io.exit_code == 0
    assert node.command == "wait"
    assert table.get(job.id).status == JobStatus.COMPLETED


@pytest.mark.asyncio
async def test_wait_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "abc"])
    assert io.exit_code == 1
    assert b"invalid job id" in io.stderr


@pytest.mark.asyncio
async def test_wait_rejects_an_unknown_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "999"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr


@pytest.mark.asyncio
async def test_wait_adopts_the_awaited_jobs_output_and_exit_code():
    table = JobTable()
    job = _submit_settled(table,
                          stdout=b"out",
                          io=IOResult(stderr=b"done", exit_code=3))
    stdout, io, _ = await handle_wait(table, ["wait", str(job.id)])
    assert stdout == b"out"
    assert io.exit_code == 3
    assert io.stderr == b"done"


@pytest.mark.asyncio
async def test_wait_accepts_the_percent_job_id_spelling():
    table = JobTable()
    job = _submit_settled(table)
    _, io, _ = await handle_wait(table, ["wait", f"%{job.id}"])
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_kill_rejects_a_missing_operand():
    _, io, _ = await handle_kill(JobTable(), ["kill"])
    assert io.exit_code == 1
    assert b"usage" in io.stderr


@pytest.mark.asyncio
async def test_kill_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_kill(JobTable(), ["kill", "abc"])
    assert io.exit_code == 1
    assert b"invalid job id" in io.stderr


@pytest.mark.asyncio
async def test_kill_rejects_an_unknown_job_id():
    _, io, _ = await handle_kill(JobTable(), ["kill", "999"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr


@pytest.mark.asyncio
async def test_kill_marks_a_known_job_killed():
    table = JobTable()
    job = _submit_pending(table)
    _, io, _ = await handle_kill(table, ["kill", str(job.id)])
    assert io.exit_code == 0
    assert table.get(job.id).status == JobStatus.KILLED


@pytest.mark.asyncio
async def test_jobs_prints_nothing_when_the_table_is_empty():
    out, io, _ = await handle_jobs(JobTable(), ["jobs"])
    assert out == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_jobs_lists_id_status_and_command():
    table = JobTable()
    done = _submit_settled(table, command="foo")
    pending = _submit_pending(table, command="bar")
    await table.wait(done.id)
    out, _, _ = await handle_jobs(table, ["jobs"])
    assert b"[1] completed foo" in out
    assert b"[2] running bar" in out
    table.kill(pending.id)


@pytest.mark.asyncio
async def test_jobs_reaps_the_completed_entries_it_reported():
    table = JobTable()
    job = _submit_settled(table)
    await table.wait(job.id)
    await handle_jobs(table, ["jobs"])
    assert table.list_jobs() == []


@pytest.mark.asyncio
async def test_ps_lists_only_the_running_jobs():
    table = JobTable()
    job = _submit_pending(table)
    done = _submit_settled(table, command="foo")
    await table.wait(done.id)
    out, _, _ = await handle_ps(table, ["ps"])
    assert out == b"1\tsleep\n"
    table.kill(job.id)


@pytest.mark.asyncio
async def test_ps_prints_nothing_when_no_job_is_running():
    out, _, _ = await handle_ps(JobTable(), ["ps"])
    assert out == b""


@pytest.mark.asyncio
async def test_fg_without_an_operand_reports_when_there_is_no_job():
    _, io, _ = await handle_fg(JobTable(), ["fg"])
    assert io.exit_code == 1
    assert io.stderr == b"fg: current: no such job\n"


@pytest.mark.asyncio
async def test_fg_rejects_an_unknown_job_id_with_the_operand_as_typed():
    _, io, _ = await handle_fg(JobTable(), ["fg", "%9"])
    assert io.exit_code == 1
    assert io.stderr == b"fg: %9: no such job\n"


@pytest.mark.asyncio
async def test_fg_echoes_the_command_line_then_adopts_the_jobs_result():
    table = JobTable()
    job = _submit_settled(table,
                          command="slow",
                          stdout=b"body",
                          io=IOResult(exit_code=7))
    stdout, io, _ = await handle_fg(table, ["fg", str(job.id)])
    assert stdout == b"slow\nbody"
    assert io.exit_code == 7
