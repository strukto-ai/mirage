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


from mirage.execution.job import JobHandle, JobTable
from mirage.execution.process.types import Process
from mirage.execution.process.view import ProcessView
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def job_result(
    cmd_str: str, msg: str, code: int
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """A job builtin's refusal: nothing on stdout, ``msg`` on stderr.

    Args:
        cmd_str (str): the command line.
        msg (str): the diagnostic, newline included.
        code (int): the exit status.
    """
    err = encode_text(msg)
    return (
        None,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err),
    )


def session_of(session: SessionState | None) -> str:
    """The job list a builtin reads: the calling session's, or the shared
    empty id when it runs with no session (a bare table in a test).

    Args:
        session (SessionState | None): the shell session, if any.
    """
    return session.session_id if session is not None else ""


def process_view(
    job_table: JobTable, session: SessionState | None
) -> ProcessView:
    """The managed runners `ps` and numeric `kill` reach, scoped by the
    session's profile.

    Args:
        job_table (JobTable): the workspace's job table.
        session (SessionState | None): the shell session, if any.
    """
    if session is None:
        return job_table.processes.view("")
    return job_table.processes.view(
        session.session_id, lambda: session.processes
    )


async def machine_process(
    processes: ProcessView, number: int
) -> tuple[Process | None, bool]:
    """The process a machine pid names: a number under ``FIRST_PID``,
    which kill, wait and ps read as the pid of a program on its machine.
    The view is brought in step with the machines first (``scan``).

    Args:
        processes (ProcessView): the session's view of the processes.
        number (int): the pid as typed.

    Returns:
        tuple[Process | None, bool]: the one process the view sees whose
        program has that pid on its machine, None for none, and whether
        processes on more than one machine have it, which bash's
        ``ambiguous job spec`` refuses.
    """
    await processes.scan()
    found = [
        process
        for process in processes.list()
        if process.machine_pid is not None
        and process.machine_pid.pid == number
        and process.machine_pid.exited is None
    ]
    machines = {str(process.machine) for process in found}
    if len(machines) > 1:
        return None, True
    return (found[0] if found else None), False


def job_numbered(jobs: list[JobHandle], job_id: int) -> JobHandle | None:
    """The job whose number is `job_id`, the one `%N` names: none once
    its report was printed, as bash then drops it from its list.

    Args:
        jobs (list[JobHandle]): the jobs the builtin can see.
        job_id (int): the job number.
    """
    return next((j for j in jobs if j.id == job_id and not j.reported), None)


def job_with_pid(jobs: list[JobHandle], pid: int) -> JobHandle | None:
    """The job a bare PID names.

    A job whose runner is here answers by its runner's PID. One with no
    runner here, restored or another workspace's, answers by the job
    number standing in for one, but only where no runner here holds that
    PID: another workspace numbers its jobs on the shared list, so its
    ``%2`` can share a number with a PID handed out here.

    Args:
        jobs (list[JobHandle]): the jobs the builtin can see.
        pid (int): the PID as typed.
    """
    ran = next(
        (j for j in jobs if j.process is not None and j.pid == pid), None
    )
    if ran is not None:
        return ran
    return next((j for j in jobs if j.process is None and j.pid == pid), None)


def resolve_spec(
    jobs: list[JobHandle], spec: str
) -> tuple[JobHandle | None, str]:
    """The job a `wait`/`disown` operand names, or bash's refusal.

    A `%N` spec that names no job is `no such job`; a bare number is a
    managed PID, also returned by `$!`, so a bare number that names no
    job is bash's `pid N is not a child of this shell`. Anything else
    is `not a pid or valid job spec`.

    Args:
        jobs (list[JobHandle]): the jobs the builtin can see.
        spec (str): the operand as typed.
    """
    if spec.startswith("%"):
        raw = spec[1:]
        job = job_numbered(jobs, int(raw)) if raw.isdigit() else None
        return job, "" if job is not None else f"{spec}: no such job"
    if spec.isdigit():
        job = job_with_pid(jobs, int(spec))
        return job, "" if job is not None else (
            f"pid {spec} is not a child of this shell"
        )
    return None, f"`{spec}': not a pid or valid job spec"
