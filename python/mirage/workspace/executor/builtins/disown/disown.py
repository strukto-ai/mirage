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


from mirage.execution.job import JobHandle, JobState, JobTable
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.builtins.jobspec import (
    job_result,
    resolve_spec,
    session_of,
)
from mirage.workspace.executor.builtins.shared import builtin_usage
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_disown(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Drop jobs from the table without stopping them.

    bash's grammar: no operand means the current job (the newest), `-a`
    every job, `-r` the running ones, and `%N`/`N` specs name jobs; `-h`
    marks a job to survive SIGHUP and otherwise leaves it in the table,
    which is a no-op here since no hangup is ever delivered. A spec that
    names no job is `no such job`, exit 1, and the others still drop.

    Args:
        job_table (JobTable): the session's jobs.
        parts (list[str]): the command words, `disown` first.
        session (SessionState | None): the shell session, whose profile
            decides which jobs are visible.
        view (SessionView | None): unused; the job-builtin signature.
    """
    cmd_str = " ".join(parts)
    sid = session_of(session)
    scan = scan_options(parts[1:], "arh")
    if scan.bad is not None:
        return job_result(
            cmd_str,
            f"{shell_voice()}disown: {scan.bad}: invalid option\n"
            f"{builtin_usage('disown')}",
            2,
        )
    all_jobs = "a" in scan.letters
    running_only = "r" in scan.letters
    keep = "h" in scan.letters
    specs = scan.operands
    targets: list[JobHandle] = []
    errors: list[str] = []
    await job_table.sync(sid)
    jobs = job_table.list_jobs(sid)
    if specs:
        for spec in specs:
            job, _ = resolve_spec(jobs, spec)
            if job is None:
                errors.append(f"{shell_voice()}disown: {spec}: no such job")
                continue
            targets.append(job)
    elif all_jobs or running_only:
        targets = (
            [j for j in jobs if j.state == JobState.RUNNING]
            if running_only
            else jobs
        )
    else:
        if not jobs:
            return job_result(
                cmd_str, f"{shell_voice()}disown: current: no such job\n", 1
            )
        targets = [jobs[-1]]
    if not keep:
        for job in targets:
            await job_table.disown(job.id, sid)
    err = encode_text("\n".join(errors) + "\n") if errors else None
    code = 1 if errors else 0
    return (
        None,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )
