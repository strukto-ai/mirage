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


import pytest

from mirage.execution.job import JobTable
from mirage.workspace.executor.builtins.jobs.jobs import handle_jobs
from tests.fixtures.job_runners import (
    submit_pending,
    submit_settled,
)


@pytest.mark.asyncio
async def test_jobs_prints_nothing_when_the_table_is_empty():
    out, io, _ = await handle_jobs(JobTable(), ["jobs"])
    assert out == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_jobs_lists_id_status_and_command():
    table = JobTable()
    done = await submit_settled(table, command="foo")
    pending = await submit_pending(table, command="bar")
    await table.wait(done.id)
    out, _, _ = await handle_jobs(table, ["jobs"])
    assert b"[1]-  Done                    foo\n" in out
    assert b"[2]+  Running                 bar &\n" in out
    await table.kill(pending.id)


@pytest.mark.asyncio
async def test_jobs_reaps_the_completed_entries_it_reported():
    table = JobTable()
    job = await submit_settled(table)
    await table.wait(job.id)
    await handle_jobs(table, ["jobs"])
    assert table.list_jobs() == []
