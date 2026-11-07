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
from mirage.workspace.executor.builtins.jobs import constants
from mirage.workspace.executor.builtins.jobspec import (
    job_numbered,
    session_of,
)
from mirage.workspace.executor.builtins.shared import builtin_usage
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _job_row(job: JobHandle, long: bool) -> str:
    """One `jobs` line in mirage's own row shape.

    Args:
        job (JobHandle): the job.
        long (bool): `-l`, which includes the managed process id.
    """
    status = (
        "running"
        if job.state == JobState.RUNNING
        else "killed"
        if job.signal is not None
        else "completed"
    )
    if long:
        return f"[{job.id}] {job.pid} {status} {job.command}"
    return f"[{job.id}] {status} {job.command}"


async def handle_jobs(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """List jobs, with bash's flags applied to mirage's row shape.

    `-p` prints the managed PID; `-s` lists nothing because suspended
    processes are unsupported. `-r` keeps running jobs, `-l` adds the PID, and
    `-n` lists only the jobs whose status changed since the last `jobs`
    (which is every completed one not yet reaped, since reaping is what
    a listing does). A jobspec operand (`%2` or `2`) filters to that
    job; one that names no job is `no such job`, exit 1. `-x` is not
    carried, and an unknown letter is GNU's usage line, exit 2.

    Args:
        job_table (JobTable): the session's jobs.
        parts (list[str]): the command words, `jobs` first.
    """
    cmd_str = " ".join(parts)
    sid = session_of(session)
    flags: set[str] = set()
    specs: list[str] = []
    for word in parts[1:]:
        if word.startswith("-") and len(word) > 1 and not specs:
            if word == "--":
                continue
            bad = next((c for c in word[1:] if c not in constants.FLAGS), None)
            if bad is not None:
                err = encode_text(
                    f"{shell_voice()}jobs: -{bad}: invalid option\n"
                    f"{builtin_usage('jobs')}"
                )
                return (
                    None,
                    IOResult(exit_code=2, stderr=err),
                    ExecutionNode(command=cmd_str, exit_code=2, stderr=err),
                )
            flags.update(word[1:])
        else:
            specs.append(word)
    table: JobTable | None = job_table
    while table is not None:
        await table.sync(sid)
        table = table.parent
    jobs = [j for j in job_table.listing(sid) if not j.reported]
    if specs:
        picked: list[JobHandle] = []
        for spec in specs:
            raw = spec.lstrip("%")
            job = job_numbered(jobs, int(raw)) if raw.isdigit() else None
            if job is None:
                err = encode_text(
                    f"{shell_voice()}jobs: {spec}: no such job\n"
                )
                return (
                    None,
                    IOResult(exit_code=1, stderr=err),
                    ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
                )
            picked.append(job)
        jobs = picked
    if "r" in flags:
        jobs = [j for j in jobs if j.state == JobState.RUNNING]
    if "s" in flags:
        jobs = []
    if "n" in flags:
        jobs = [j for j in jobs if j.state != JobState.RUNNING]
    if "p" in flags:
        lines = [str(j.pid) for j in jobs]
    else:
        lines = [_job_row(j, "l" in flags) for j in jobs]
    await job_table.pop_completed(sid)
    out = encode_text("\n".join(lines) + "\n") if lines else b""
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)
