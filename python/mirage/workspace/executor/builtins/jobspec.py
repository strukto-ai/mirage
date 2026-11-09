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
from collections.abc import Awaitable
from typing import TypeVar

from mirage.execution.job import JobHandle
from mirage.execution.process.config import ProcessPermissions
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.execution.process.types import Process
from mirage.execution.types import MachinePid
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.machine.constants import RUN_WATCH_SECONDS
from mirage.shell.bytes import encode_text
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

T = TypeVar("T")

AMBIGUOUS_SPEC = "ambiguous job spec"


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


def grants_of(session: SessionState | None) -> ProcessPermissions:
    """What `ps` and numeric `kill` may reach, by the session's profile.

    Args:
        session (SessionState | None): the shell session, if any.
    """
    return session.processes if session is not None else ProcessPermissions()


async def scanning_while(processes: ProcessTable, waiting: Awaitable[T]) -> T:
    """Wait for ``waiting``, looking at the machines every
    ``RUN_WATCH_SECONDS`` meanwhile, so a run whose exec stays open ends
    when its program does.

    Args:
        processes (ProcessTable): the workspace's processes.
        waiting (Awaitable[T]): what is waited for.
    """
    task = asyncio.ensure_future(waiting)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=RUN_WATCH_SECONDS)
            if done:
                return task.result()
            await processes.scan()
    except asyncio.CancelledError:
        task.cancel()
        raise


def on_machine(process: Process, name: str | None) -> bool:
    """Whether ``-m`` picks a process: ``name`` as ``ps`` shows its
    machine, or without the provider.

    Args:
        process (Process): the process.
        name (str | None): the option's value, None for no ``-m``.
    """
    shown = process.shown_machine
    return name is None or name in (shown, shown.rpartition(":")[2])


async def machine_process(
    processes: ProcessTable,
    session: SessionState | None,
    number: int,
    machine: str | None = None,
) -> tuple[Process | None, bool]:
    """The process a machine pid names: a number under ``FIRST_PID``,
    which kill, wait and ps read as the pid of a program on its machine.
    The table is brought in step with the machines first (``scan``).

    Args:
        processes (ProcessTable): the workspace's processes.
        session (SessionState | None): the shell session, if any.
        number (int): the pid as typed.
        machine (str | None): only that machine's (``on_machine``).

    Returns:
        tuple[Process | None, bool]: the one process it sees whose
        program has that pid on its machine, None for none, and whether
        processes on more than one machine have it, which bash's
        ``ambiguous job spec`` refuses.
    """
    await processes.scan()
    found = [
        process
        for process in processes.visible(
            session_of(session), grants_of(session)
        )
        if process.machine_pid is not None
        and process.machine_pid.pid == number
        and process.machine_pid.exited is None
        and on_machine(process, machine)
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


async def job_with_machine_pid(
    processes: ProcessTable,
    jobs: list[JobHandle],
    number: int,
    machine: str | None = None,
) -> tuple[JobHandle | None, bool]:
    """The job whose own process ran the program a machine pid names,
    which ``wait`` reads as the pid of a program on its machine. A job
    whose program has ended still answers until the job is collected.
    The table is brought in step with the machines first (``scan``),
    which learns a program's pid there.

    Args:
        processes (ProcessTable): the workspace's processes.
        jobs (list[JobHandle]): the jobs the builtin can see.
        number (int): the pid as typed.
        machine (str | None): only that machine's (``on_machine``).

    Returns:
        tuple[JobHandle | None, bool]: the job, a running program's
        before an ended one's, None for none, and whether jobs on more
        than one machine ran a program with that pid, which bash's
        ``ambiguous job spec`` refuses.
    """
    await processes.scan()
    held: list[tuple[JobHandle, MachinePid]] = []
    machines: set[str] = set()
    for job in jobs:
        record = job.process.record if job.process is not None else None
        if record is None or record.machine_pid is None:
            continue
        if record.machine_pid.pid != number or not on_machine(record, machine):
            continue
        held.append((job, record.machine_pid))
        machines.add(str(record.machine))
    if len(machines) > 1:
        return None, True
    held.sort(key=lambda pair: pair[1].exited is not None)
    return (held[0][0] if held else None), False


def stage_with_pid(
    jobs: list[JobHandle], pid: int
) -> tuple[JobHandle, ProcessHandle] | None:
    """The stage of a background pipeline a pid names, as ``ps`` shows
    it, and its job.

    Args:
        jobs (list[JobHandle]): the jobs the builtin can see.
        pid (int): the pid as typed.
    """
    for job in jobs:
        for stage in () if job.process is None else job.process.stages:
            if stage.record.shown_pid == pid:
                return job, stage
    return None


def job_of_spec(
    jobs: list[JobHandle], spec: str
) -> tuple[JobHandle | None, str]:
    """The job a ``%`` spec names: ``%N``; ``%%``, ``%+`` or a bare ``%``
    for the newest, ``%-`` for the one before it; ``%name`` for the job
    whose command starts with ``name`` and ``%?text`` for the one whose
    command holds ``text``.

    Args:
        jobs (list[JobHandle]): the jobs the builtin can see.
        spec (str): the operand, ``%`` first.

    Returns:
        tuple[JobHandle | None, str]: the job, or bash's refusal.
    """
    body = spec[1:]
    missing = f"{spec}: no such job"
    if body.isdigit():
        numbered = job_numbered(jobs, int(body))
        return numbered, "" if numbered is not None else missing
    listed = sorted(
        (job for job in jobs if not job.reported),
        key=lambda job: job.id,
        reverse=True,
    )
    if body in ("", "%", "+", "-"):
        if not listed:
            return None, missing
        return listed[1 if body == "-" and len(listed) > 1 else 0], ""
    anywhere = body.startswith("?")
    text = body[1:] if anywhere else body
    named = [
        job
        for job in listed
        if (text in job.command if anywhere else job.command.startswith(text))
    ]
    if len(named) > 1:
        return None, f"{text}: {AMBIGUOUS_SPEC}"
    return (named[0], "") if named else (None, missing)


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
        (
            j
            for j in jobs
            if j.process is not None
            and (j.pid == pid or pid in j.process.record.stages)
        ),
        None,
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
        return job_of_spec(jobs, spec)
    if spec.isdigit():
        job = job_with_pid(jobs, int(spec))
        return job, "" if job is not None else (
            f"pid {spec} is not a child of this shell"
        )
    return None, f"`{spec}': not a pid or valid job spec"
