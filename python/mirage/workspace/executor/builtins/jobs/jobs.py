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
from mirage.shell.signals import process_status
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobs import constants
from mirage.workspace.executor.builtins.jobspec import (
    AMBIGUOUS_SPEC,
    job_of_spec,
    session_of,
)
from mirage.workspace.executor.builtins.shared import builtin_usage
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _job_status(job: JobHandle) -> str:
    """How bash's ``jobs`` words where a job stands.

    Args:
        job (JobHandle): the job.
    """
    if job.state == JobState.RUNNING:
        return "Running"
    ended = job.signal
    if ended is None and job.process is not None:
        ended = job.process.ended_by
    return process_status(job.exit_code, ended)


def _job_row(job: JobHandle, long: bool, mark: str) -> str:
    """One `jobs` line, in bash's layout.

    Args:
        job (JobHandle): the job.
        long (bool): `-l`, which includes its pid.
        mark (str): `+` for the newest job, `-` for the one before it,
            else a space.
    """
    status = f"{_job_status(job):<24}"
    running = " &" if job.state == JobState.RUNNING else ""
    stages = () if job.process is None else job.process.stages
    if long and stages:
        first, *rest = [stage.record for stage in stages]
        rows = [
            f"[{job.id}]{mark} {first.shown_pid:5d} {status}{first.command}"
        ]
        rows += [f"{'':5}{r.shown_pid:5d} {'':22}| {r.command}" for r in rest]
        return "\n".join(rows) + running
    command = job.command + running
    if long:
        return f"[{job.id}]{mark} {job.shown_pid:5d} {status}{command}"
    return f"[{job.id}]{mark}  {status}{command}"


async def handle_jobs(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """List jobs as bash does, the machines looked at first.

    `-p` prints the PID; `-s` lists nothing because a non-interactive
    shell reports no job as stopped. `-r` keeps running jobs, `-l` adds the PID, and
    `-n` lists only the jobs whose status changed since a `jobs` last
    showed them: one never shown, and every completed one not yet reaped,
    since reaping is what a listing does. A jobspec operand filters to that
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
    await job_table.processes.scan()
    jobs = [j for j in job_table.listing(sid) if not j.reported]
    current, previous = job_table.job_marks(sid)
    marks = {current: "+", previous: "-"}
    if specs:
        picked: list[JobHandle] = []
        for spec in specs:
            job, refusal = job_of_spec(
                jobs, spec if spec.startswith("%") else f"%{spec}"
            )
            if job is None:
                said = f"{shell_voice()}jobs: {spec}: no such job\n"
                err = encode_text(
                    f"{shell_voice()}jobs: {refusal}\n{said}"
                    if refusal.endswith(AMBIGUOUS_SPEC)
                    else said
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
        jobs = [j for j in jobs if not j.listed or j.state != JobState.RUNNING]
    if "p" in flags:
        lines = [str(j.shown_pid) for j in jobs]
    else:
        lines = [_job_row(j, "l" in flags, marks.get(j.id, " ")) for j in jobs]
        for j in jobs:
            j.listed = True
    await job_table.pop_completed(sid)
    out = encode_text("\n".join(lines) + "\n") if lines else b""
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)
