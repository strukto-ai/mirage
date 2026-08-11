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
from mirage.resource.ram import RAMResource
from mirage.shell.console import Channel
from mirage.shell.job_table import JobStatus
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.types import ExecutionNode

_RELEASE: list[asyncio.Event] = []


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


async def _deaf_run(job):
    """A runner that swallows the cancel and keeps going.

    Deliberately not ``sleep``: that is the one command which consumes
    the signal, so it settles through its own runner and would pass even
    when teardown merely requests a cancel. Only settling in teardown
    ends this one.

    Args:
        job: the job being run, whose console proves it started.
    """
    await job.console.emit(Channel.STDOUT, b"partial")
    release = asyncio.Event()
    _RELEASE.append(release)
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError:
        await release.wait()
    return IOResult(exit_code=0), ExecutionNode(command="deaf", exit_code=0)


async def _submit_deaf(ws: Workspace):
    """Start a deaf job and return it once it is genuinely running.

    Args:
        ws (Workspace): workspace whose table receives the job.
    """
    job = ws.job_table.submit(command="deaf", run=_deaf_run, cwd="/")
    while not await job.console.snapshot(Channel.STDOUT):
        await asyncio.sleep(0)
    return job


@pytest.mark.asyncio
async def test_close_settles_a_job_that_ignores_the_cancel():
    """Teardown records the outcome, it does not only request a cancel.

    A bare cancel leaves the job RUNNING with no ending chunk, so anyone
    parked on ``wait_finished`` waits forever on a workspace that is
    already gone. ``kill_all`` never joins the runner, so settling here
    cannot block shutdown on a job that is mid-write.
    """
    _RELEASE.clear()
    ws = _workspace()
    job = await _submit_deaf(ws)
    try:
        await asyncio.wait_for(ws.close(), timeout=5)

        assert job.status == JobStatus.KILLED
        assert job.exit_code == 137
        await asyncio.wait_for(job.console.wait_finished(), timeout=2)
    finally:
        # Unconditional: a failed assertion above must still unblock the
        # runner, or the pending task turns a clean failure into a hang
        # at loop teardown.
        for release in _RELEASE:
            release.set()
        await asyncio.sleep(0)

    # The runner unwinding afterwards must not reopen or relabel it.
    assert job.status == JobStatus.KILLED


@pytest.mark.asyncio
async def test_close_is_idempotent_with_a_job_running():
    _RELEASE.clear()
    ws = _workspace()
    job = await _submit_deaf(ws)
    try:
        await asyncio.wait_for(ws.close(), timeout=5)
        await asyncio.wait_for(ws.close(), timeout=5)

        assert job.status == JobStatus.KILLED
    finally:
        for release in _RELEASE:
            release.set()
        await asyncio.sleep(0)
