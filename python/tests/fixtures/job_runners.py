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

from mirage.execution.job import JobHandle, JobTable
from mirage.io import IOResult
from mirage.shell.console import Channel
from mirage.workspace.types import ExecutionNode


async def emit_and_settle(
    job: JobHandle,
    stdout: bytes = b"",
    stderr: bytes = b"",
    exit_code: int = 0,
) -> tuple[IOResult, ExecutionNode]:
    """A runner that prints to its console and ends with a status.

    Args:
        job (JobHandle): the job being run.
        stdout (bytes): what the job prints on stdout.
        stderr (bytes): what the job prints on stderr.
        exit_code (int): the job's exit status.
    """
    if stdout:
        await job.console.emit(Channel.STDOUT, stdout)
    if stderr:
        await job.console.emit(Channel.STDERR, stderr)
    return IOResult(exit_code=exit_code), ExecutionNode()


async def run_forever(job: JobHandle) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (JobHandle): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


async def emit_after(
    job: JobHandle, gate: asyncio.Event
) -> tuple[IOResult, ExecutionNode]:
    """A runner that prints only once the test opens ``gate``, so it is
    still running while ``fg`` picks a job.

    Args:
        job (JobHandle): the job being run.
        gate (asyncio.Event): what the runner waits on before printing.
    """
    await gate.wait()
    return await emit_and_settle(job, stdout=b"late")


async def submit_settled(
    table: JobTable,
    command: str = "foo",
    stdout: bytes = b"",
    stderr: bytes = b"",
    exit_code: int = 0,
) -> JobHandle:
    """Start a job that prints and ends with a status at once.

    Args:
        table (JobTable): the table to start it in.
        command (str): the job's command line.
        stdout (bytes): what the job prints on stdout.
        stderr (bytes): what the job prints on stderr.
        exit_code (int): the job's exit status.
    """
    return await table.submit(
        command=command,
        run=partial(
            emit_and_settle, stdout=stdout, stderr=stderr, exit_code=exit_code
        ),
        cwd="/",
    )


async def submit_pending(table: JobTable, command: str = "sleep") -> JobHandle:
    """Start a job that runs until it is killed.

    Args:
        table (JobTable): the table to start it in.
        command (str): the job's command line.
    """
    return await table.submit(command=command, run=run_forever, cwd="/")
