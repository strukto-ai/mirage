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

from mirage.execution.job import JobTable
from mirage.shell.console import Channel, JobConsole
from mirage.workspace.executor.builtins.fg.fg import handle_fg
from tests.fixtures.job_runners import (
    emit_after,
    submit_settled,
)


@pytest.mark.asyncio
async def test_fg_without_an_operand_reports_when_there_is_no_job():
    _, io, _ = await handle_fg(JobTable(), ["fg"])
    assert io.exit_code == 1
    assert io.stderr == b"bash: fg: current: no such job\n"


@pytest.mark.asyncio
async def test_fg_without_an_operand_takes_a_job_that_already_finished():
    # A background job can end before `fg` runs; it is still the current
    # job, as `fg %N` would find it.
    table = JobTable()
    job = await submit_settled(
        table, command="quick", stdout=b"body", exit_code=3
    )
    await table.wait(job.id)
    stdout, io, _ = await handle_fg(table, ["fg"])
    assert stdout == b"quick\n"
    assert io.exit_code == 3


@pytest.mark.asyncio
async def test_fg_without_an_operand_prefers_a_running_job_to_a_finished_one():
    # bash's current job is the newest one still running; a finished job
    # answers only when nothing runs. The older job holds until fg has
    # picked, which it has done by the next turn.
    table = JobTable()
    gate = asyncio.Event()
    await table.submit("older", partial(emit_after, gate=gate), cwd="/")
    done = await submit_settled(table, command="newer", stdout=b"early")
    await table.wait(done.id)
    fg = asyncio.create_task(handle_fg(table, ["fg"]))
    await asyncio.sleep(0)
    gate.set()
    stdout, _, _ = await fg
    assert stdout == b"older\n"


@pytest.mark.asyncio
async def test_fg_rejects_an_unknown_job_id_with_the_operand_as_typed():
    _, io, _ = await handle_fg(JobTable(), ["fg", "%9"])
    assert io.exit_code == 1
    assert io.stderr == b"bash: fg: %9: no such job\n"


@pytest.mark.asyncio
async def test_fg_echoes_the_command_line_then_answers_the_jobs_status():
    table = JobTable()
    job = await submit_settled(
        table, command="slow", stdout=b"body", exit_code=7
    )
    stdout, io, _ = await handle_fg(table, ["fg", str(job.id)])
    assert stdout == b"slow\n"
    assert io.exit_code == 7


@pytest.mark.asyncio
async def test_fg_writes_the_command_line_before_it_blocks():
    table = JobTable()
    gate = asyncio.Event()
    await table.submit("held", partial(emit_after, gate=gate), cwd="/")
    sink = JobConsole()
    fg = asyncio.create_task(handle_fg(table, ["fg"], sink=sink))
    await asyncio.sleep(0)
    assert await sink.snapshot(Channel.STDOUT) == b"held\n"
    gate.set()
    stdout, _, _ = await fg
    assert stdout is None
