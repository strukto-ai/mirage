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

from mirage.execution.job import JobTable
from mirage.io import IOResult
from mirage.workspace.executor.builtins.disown.disown import handle_disown
from mirage.workspace.types import ExecutionNode


async def _brief(job):
    await asyncio.sleep(0.05)
    return IOResult(), ExecutionNode(command="j", exit_code=0)


@pytest.mark.asyncio
async def test_disown_drops_a_job_from_the_table():
    table = JobTable()
    await table.submit("sleep", _brief, cwd="/")
    _, io, _ = await handle_disown(table, ["disown"])
    assert io.exit_code == 0
    assert table.list_jobs() == []
    await table.kill_all()


@pytest.mark.asyncio
async def test_disown_unknown_job_and_bad_option():
    _, io, _ = await handle_disown(JobTable(), ["disown", "%9"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr
    _, io, _ = await handle_disown(JobTable(), ["disown", "-x"])
    assert io.exit_code == 2
