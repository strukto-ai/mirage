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


from mirage.execution.job import JobState, JobTable
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.shell.console import (
    Channel,
    JobConsole,
)
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import (
    job_numbered,
    session_of,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_fg(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Foreground a background job: print its command line, then block
    on it and answer its exit code. Its output goes where it always
    went, as it is written, so the command line goes out first.

    With no operand it takes the newest running job, which is bash's
    current job; when none runs, it takes the newest finished one, as
    ``fg %N`` would.

    Args:
        job_table (JobTable): the session's job table.
        parts (list[str]): argv including the command name; the
            optional operand is a job id, with or without ``%``.
        session (SessionState | None): the shell session, whose profile
            decides which jobs are visible and whether the command line
            is printed.
        view (SessionView | None): the gated session view.
        sink (JobConsole | None): where the statement writes, so the
            command line is there before the job's next bytes.
    """
    cmd_str = " ".join(parts)
    sid = session_of(session)
    await job_table.sync(sid)
    jobs = job_table.list_jobs(sid)
    if len(parts) <= 1:
        if not jobs:
            err = encode_text(f"{shell_voice()}fg: current: no such job\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
            )
        running = [j for j in jobs if j.state == JobState.RUNNING]
        target = (running or jobs)[-1]
    else:
        raw = parts[1].lstrip("%")
        try:
            job_id = int(raw)
        except ValueError:
            err = encode_text(f"{shell_voice()}fg: {parts[1]}: no such job\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
            )
        numbered = job_numbered(jobs, job_id)
        if numbered is None:
            err = encode_text(f"{shell_voice()}fg: {parts[1]}: no such job\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
            )
        target = numbered
    header = encode_text(target.command + "\n")
    if sink is not None:
        await sink.emit(Channel.STDOUT, header)
    job = await job_table.wait(target.id, sid)
    await job_table.reap(target.id, sid)
    return (
        header if sink is None else None,
        IOResult(exit_code=job.exit_code),
        ExecutionNode(command=cmd_str, exit_code=job.exit_code),
    )
