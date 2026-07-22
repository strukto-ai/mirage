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

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.background import BackgroundJobs


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def jobs(workspace):
    return BackgroundJobs(workspace)


async def _settle(jobs, shell_id, tries=50):
    for _ in range(tries):
        chunk = jobs.output(shell_id)
        if not chunk.running:
            return chunk
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {shell_id} never finished")


@pytest.mark.asyncio
async def test_start_returns_running_handle(jobs):
    job = await jobs.start("echo hi")

    assert job.shell_id == "1"
    assert job.command == "echo hi"
    assert job.running
    assert job.exit_code is None


@pytest.mark.asyncio
async def test_output_reports_completion(jobs):
    job = await jobs.start("echo hello")

    chunk = await _settle(jobs, job.shell_id)

    assert chunk.stdout == "hello\n"
    assert chunk.exit_code == 0


@pytest.mark.asyncio
async def test_output_is_incremental(jobs):
    job = await jobs.start("echo once")
    await _settle(jobs, job.shell_id)

    again = jobs.output(job.shell_id)

    assert again.stdout == ""
    assert again.exit_code == 0


@pytest.mark.asyncio
async def test_output_rejects_unknown_shell(jobs):
    with pytest.raises(KeyError):
        jobs.output("404")
    with pytest.raises(KeyError):
        jobs.output("not-a-number")


@pytest.mark.asyncio
async def test_info_lists_every_job(jobs):
    first = await jobs.start("echo a")
    second = await jobs.start("echo b")

    listed = {job.shell_id: job.command for job in jobs.info()}

    assert listed == {first.shell_id: "echo a", second.shell_id: "echo b"}


@pytest.mark.asyncio
async def test_kill_stops_a_running_job(jobs):
    job = await jobs.start("sleep 30")

    assert jobs.kill(job.shell_id)

    chunk = jobs.output(job.shell_id)
    assert not chunk.running
    assert chunk.exit_code == 137


@pytest.mark.asyncio
async def test_kill_is_false_for_finished_and_unknown_jobs(jobs):
    job = await jobs.start("echo done")
    await _settle(jobs, job.shell_id)

    assert not jobs.kill(job.shell_id)
    assert not jobs.kill("404")


@pytest.mark.asyncio
async def test_kill_all_stops_every_running_job(jobs):
    await jobs.start("sleep 30")
    await jobs.start("sleep 30")

    jobs.kill_all()

    assert not any(job.running for job in jobs.info())
