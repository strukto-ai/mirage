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

from mirage.context import get_current_evaluation
from mirage.execution.job import JobHandle, JobState, JobTable
from mirage.execution.job.constants import JUST_ENDED_SECONDS
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.machine.constants import RUN_DRAIN_SECONDS
from mirage.shell.bytes import encode_text
from mirage.shell.constants import NOT_FOUND_STATUS
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.background import report_jobs
from mirage.workspace.executor.builtins.constants import IDENTIFIER_RE
from mirage.workspace.executor.builtins.jobspec import (
    job_result,
    job_with_machine_pid,
    resolve_spec,
    scanning_while,
    session_of,
    stage_with_pid,
)
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    identifier_line,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def _wait_first(job_table: JobTable, jobs: list[JobHandle]) -> JobHandle:
    """Block until the first of several jobs ends, and return it.

    Args:
        job_table (JobTable): the session's jobs.
        jobs (list[JobHandle]): the candidates, all present in the table.
    """
    for job in jobs:
        if job.state != JobState.RUNNING:
            return await job_table.wait(job.id, job.session_id)
    tasks = {
        asyncio.ensure_future(job_table.wait(job.id, job.session_id)): job
        for job in jobs
    }
    done, pending = await asyncio.wait(
        tasks, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    first = min(done, key=lambda t: tasks[t].id)
    return tasks[first]


async def _reaped(
    job_table: JobTable, job: JobHandle, cmd_str: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Report one finished job's status, and reap it.

    Its output already went where its shell writes as it was written.

    Args:
        job_table (JobTable): the session's jobs.
        job (JobHandle): the job, already finished.
        cmd_str (str): the command line, for the node.
    """
    # Reaped like GNU bash reaps a job waited on by id, so a later bare
    # `wait` does not answer for it again.
    await job_table.reap(job.id, job.session_id)
    return (
        None,
        IOResult(exit_code=job.exit_code),
        ExecutionNode(command=cmd_str, exit_code=job.exit_code),
    )


async def _waited_stage(
    job_table: JobTable,
    processes: ProcessTable,
    session: SessionState | None,
    job: JobHandle,
    stage: ProcessHandle,
) -> int:
    """Wait for one stage of a background pipeline and answer its status.
    ``wait $!`` names the last, which answers for the pipeline as far as
    it has ended under ``pipefail``, and leaves the job's list, as bash
    forgets a job once its last process has been waited for.

    Args:
        job_table (JobTable): the session's jobs.
        processes (ProcessTable): the workspace's processes.
        session (SessionState | None): the shell, None for a bare table.
        job (JobHandle): the stage's job.
        stage (ProcessHandle): the stage.
    """
    ended = await scanning_while(processes, stage.join())
    assert job.process is not None
    stages = job.process.stages
    if stages[-1] is not stage:
        return ended.exit or 0
    if job.state == JobState.RUNNING:
        await job_table.disown(job.id, job.session_id)
    else:
        await job_table.reap(job.id, job.session_id)
    if session is None or not session.shell_options.get("pipefail"):
        return ended.exit or 0
    # What ended with it may be on a machine, which tells a moment later.
    others = [asyncio.ensure_future(s.join()) for s in stages[:-1]]
    await asyncio.wait(others, timeout=RUN_DRAIN_SECONDS)
    for other in others:
        other.cancel()
    return next((s.record.exit for s in reversed(stages) if s.record.exit), 0)


async def handle_wait(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Wait for background jobs, with bash's option surface.

    A job's output went where its shell writes as it was written, so
    `wait` prints none, as bash's does. Bare `wait` joins every job;
    `wait ID...` joins those and answers the last one's status; `-n`
    joins the first of the given jobs (or of all) to finish and answers
    its status, 127 when there is nothing to wait for; `-p VAR` stores
    the id of the job whose status is answered, and unsets VAR when
    none is (which is the bare form, since it reports no one job);
    `-f` is accepted, since waiting already lasts until a job ends;
    `-m MACHINE` reads a pid as that machine's.

    `-p` stores the PID `$!` and `jobs -p` show. While it waits it looks
    at the machines every couple of seconds, so a program whose exec
    stays open ends when it does.
    A spec naming no job is bash's own message and 127; a word that is
    neither is `not a pid or valid job spec` and 1.

    Args:
        job_table (JobTable): the session's jobs.
        parts (list[str]): the command words, `wait` first.
        session (SessionState | None): shell session state, for `-p`.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    sid = session_of(session)
    next_job = False
    var: str | None = None
    machine: str | None = None
    specs: list[str] = []
    i = 1
    while i < len(parts):
        word = parts[i]
        if specs or not word.startswith("-") or word == "-":
            specs.append(word)
            i += 1
            continue
        if word == "--":
            specs.extend(parts[i + 1 :])
            break
        j = 1
        while j < len(word):
            ch = word[j]
            if ch == "n":
                next_job = True
            elif ch == "f":
                pass
            elif ch in ("p", "m"):
                rest = word[j + 1 :]
                if not rest and i + 1 >= len(parts):
                    return job_result(
                        cmd_str,
                        f"{shell_voice()}wait: -{ch}: option requires an "
                        f"argument\n{builtin_usage('wait')}",
                        2,
                    )
                if not rest:
                    i += 1
                    rest = parts[i]
                if ch == "p":
                    var = rest
                else:
                    machine = rest
                break
            else:
                return job_result(
                    cmd_str,
                    f"{shell_voice()}wait: -{ch}: invalid option\n"
                    f"{builtin_usage('wait')}",
                    2,
                )
            j += 1
        i += 1
    if var is not None:
        if IDENTIFIER_RE.fullmatch(var) is None:
            return job_result(
                cmd_str,
                identifier_line("wait", var) + "\n",
                1,
            )
        if view is not None and view.is_readonly(var):
            return job_result(
                cmd_str,
                f"{shell_voice()}wait: {var}: cannot unset: readonly variable\n",
                1,
            )
        if view is not None:
            await view.unset(var)
    errors: list[str] = []
    picked: list[JobHandle] = []
    await job_table.sync(sid)
    visible = job_table.list_jobs(sid)
    processes = job_table.processes
    answered: int | None = None
    for spec in specs:
        stage = (
            stage_with_pid(visible, int(spec))
            if spec.isdigit() and not next_job
            else None
        )
        if stage is not None:
            answered = await _waited_stage(
                job_table, processes, session, *stage
            )
            continue
        answered = None
        if spec.isdigit() and 0 < int(spec) < FIRST_PID:
            job, ambiguous = await job_with_machine_pid(
                processes, visible, int(spec), machine
            )
            if ambiguous:
                errors.append(
                    f"{shell_voice()}wait: {spec}: ambiguous job spec"
                )
                continue
            refusal = f"pid {spec} is not a child of this shell"
        else:
            job, refusal = resolve_spec(visible, spec)
        if job is None:
            answered = (
                job_table.saved_status(sid, int(spec))
                if spec.isdigit()
                else None
            )
            if answered is None:
                errors.append(f"{shell_voice()}wait: {refusal}")
            continue
        picked.append(job)
    err_text = ("\n".join(errors) + "\n") if errors else ""
    if next_job:
        candidates = picked if specs else visible
        if not candidates:
            # Nothing to wait for: the specs were all bad, or there are
            # no jobs. bash reports any bad spec and answers 127.
            code = NOT_FOUND_STATUS
            return (
                None,
                IOResult(exit_code=code, stderr=encode_text(err_text) or None),
                ExecutionNode(command=cmd_str, exit_code=code),
            )
        job = await scanning_while(
            processes, _wait_first(job_table, candidates)
        )
        if var is not None and view is not None:
            await view.set(var, str(job.shown_pid))
        told = _wait_reports(session, job_table)
        stdout, io, node = await _reaped(job_table, job, cmd_str)
        if err_text or told:
            io.stderr = encode_text(err_text) + told
        return stdout, io, node
    if not specs:
        began = job_table.clock.now()
        await scanning_while(processes, job_table.wait_all(sid))
        keep = _left_listed(session, visible, began)
        told = _wait_reports(session, job_table)
        await job_table.pop_completed(sid, keep)
        return (
            None,
            IOResult(stderr=told or None),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    if answered is not None and not picked:
        code = answered
        return (
            None,
            IOResult(exit_code=code, stderr=encode_text(err_text) or None),
            ExecutionNode(command=cmd_str, exit_code=code),
        )
    if not picked:
        # Every spec was refused: bash answers 127 for a job it cannot
        # find and 1 for a word that is not a spec at all, the last
        # refusal deciding.
        last = errors[-1]
        code = (
            1
            if last.endswith("not a pid or valid job spec")
            else NOT_FOUND_STATUS
        )
        return job_result(cmd_str, err_text, code)
    finished = [
        await scanning_while(processes, job_table.wait(job.id, sid))
        for job in picked
    ]
    told = _wait_reports(session, job_table)
    last_code = 0
    last_job: JobHandle | None = None
    for job in finished:
        _, io, _ = await _reaped(job_table, job, cmd_str)
        last_code = io.exit_code
        last_job = job
    if answered is not None:
        last_code = answered
    # `wait id1 id2` answers with the last id's status, so `-p` names
    # that same job however many were waited for. Only the no-operand
    # form leaves the variable unset, since it reports no one job.
    if var is not None and view is not None and last_job is not None:
        await view.set(var, str(last_job.shown_pid))
    return (
        None,
        IOResult(
            exit_code=last_code, stderr=encode_text(err_text) + told or None
        ),
        ExecutionNode(command=cmd_str, exit_code=last_code),
    )


def _left_listed(
    session: SessionState | None, jobs: list[JobHandle], began: float
) -> int | None:
    """The job a bare ``wait`` leaves in the list for one ``jobs``: the
    one ``$!`` names, if it ended while another job still ran, or before
    the ``wait`` unless it is the only job and only just ended. A job
    the ``wait`` ended on goes.

    Args:
        session (SessionState | None): the shell session, if any.
        jobs (list[JobHandle]): the jobs as ``wait`` began.
        began (float): when ``wait`` began.
    """
    last = session.last_bg_job_id if session is not None else None
    job = next((j for j in jobs if j.last_pid == last), None)
    if job is None or job.ended_at is None:
        return None
    if any(other.ending > job.ending for other in jobs):
        return job.id
    if job.ended_at > began:
        return None
    if len(jobs) == 1 and began - job.ended_at < JUST_ENDED_SECONDS:
        return None
    return job.id


def _wait_reports(session: SessionState | None, job_table: JobTable) -> bytes:
    """What ``wait`` tells of the jobs a signal ended once it waited
    (``report_jobs``), before it reaps them.

    Args:
        session (SessionState | None): the shell, None for a bare table.
        job_table (JobTable): its jobs.
    """
    if session is None:
        return b""
    context = get_current_evaluation()
    if context is None or context.session is not session:
        context = EvaluationContext(session)
    return report_jobs(context, job_table)
