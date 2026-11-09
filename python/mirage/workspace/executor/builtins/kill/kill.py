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

from mirage.context import (
    current_caller,
    session_voice,
)
from mirage.execution.job import JobHandle, JobTable
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.types import ProcessState
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.shell.constants import SIGTERM
from mirage.shell.signals import (
    listed_signal,
    signal_number,
    signal_table,
)
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.constants import MAX_PID_OPERAND
from mirage.workspace.executor.builtins.jobspec import (
    grants_of,
    job_of_spec,
    job_result,
    machine_process,
    on_machine,
    session_of,
)
from mirage.workspace.executor.builtins.shared import builtin_usage
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _kill_list(
    cmd_str: str, words: list[str], voice: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``kill -l``: the signal table, or each operand's name for a
    number (a ``$?`` of 128 plus one too) and number for a name.

    Args:
        cmd_str (str): the command line.
        words (list[str]): the operands after ``-l``.
        voice (str): the prefix bash's diagnostics carry.
    """
    if words[:1] == ["--"]:
        words = words[1:]
    if not words:
        out = encode_text(signal_table())
        return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)
    lines: list[str] = []
    errors: list[str] = []
    for word in words:
        line = listed_signal(word)
        if line is None:
            errors.append(f"{voice}kill: {word}: invalid signal specification")
        elif line:
            lines.append(line)
    code = 1 if errors else 0
    out = encode_text("".join(f"{line}\n" for line in lines))
    err = encode_text("".join(f"{line}\n" for line in errors))
    return (
        out,
        IOResult(exit_code=code, stderr=err or None),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err),
    )


def _kill_pid(jobs: list[JobHandle], operand: str) -> tuple[int | None, str]:
    """The managed PID one kill operand names, or bash's refusal.

    A ``%N`` job with no process, one restored from a snapshot, has
    ended: it answers no such process, and never reaches the process
    table, where its stand-in PID may name another process.

    Args:
        jobs (list[JobHandle]): the jobs the builtin can see.
        operand (str): the operand as typed.
    """
    if operand == "":
        return None, "`': not a pid or valid job spec"
    if operand.startswith("%"):
        job, refusal = job_of_spec(jobs, operand)
        if job is None:
            return None, refusal
        if job.process is None:
            return None, f"({job.pid}) - No such process"
        return job.pid, ""
    digits = operand[1:] if operand.startswith("-") else operand
    if (
        not digits.isascii()
        or not digits.isdigit()
        or int(digits) > MAX_PID_OPERAND
    ):
        return None, f"{operand}: arguments must be process or job IDs"
    return int(operand), ""


async def handle_kill(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Signal managed runners with bash's kill surface.

    The signal comes from ``-s``/``-n``, or from the first ``-sigspec``;
    ``0`` probes, and each process does what the signal does
    (``ProcessTable.signal``). A
    number under ``FIRST_PID`` is a machine pid (``machine_process``).
    Every
    operand is tried and each failure is named in bash's words; the
    status is 0 when any operand was signalled, as bash's is. A job
    spec is ``%N``; a negative number is a process group, the session's
    ``-$$`` among them, whose every runner gets the signal (killpg). A
    signal that stops the shell running ``kill`` lands before the next
    statement, as bash's signal to itself does.

    Args:
        job_table (JobTable): the session's jobs.
        parts (list[str]): the command words, `kill` first.
        session (SessionState | None): the shell session, if any.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    sid = session_of(session)
    signal = SIGTERM
    words = parts[1:]
    saw_signal = False
    machine: str | None = None
    voice = shell_voice() if session is None else session_voice(session)
    if words[:1] in (["-l"], ["-L"]):
        return _kill_list(cmd_str, words[1:], voice)
    while words:
        word = words[0]
        if word in ("-s", "-n"):
            if len(words) < 2:
                return job_result(
                    cmd_str,
                    f"{voice}kill: {word}: option requires an argument\n",
                    1,
                )
            spec, words = words[1], words[2:]
        elif word == "-m":
            if len(words) < 2:
                return job_result(
                    cmd_str,
                    f"{voice}kill: -m: option requires an argument\n",
                    1,
                )
            machine, words = words[1], words[2:]
            continue
        elif word == "--":
            words = words[1:]
            break
        elif word == "-?":
            return job_result(cmd_str, builtin_usage("kill"), 2)
        elif (word[:2] == "-s" and word[2:3].isalpha()) or (
            word[:2] == "-n" and word[2:3].isdigit()
        ):
            spec, words = word[2:], words[1:]
        elif word.startswith("-") and len(word) > 1 and not saw_signal:
            spec, words = word[1:], words[1:]
        else:
            break
        number = signal_number(spec)
        if number is None:
            return job_result(
                cmd_str,
                f"{voice}kill: {spec}: invalid signal specification\n",
                1,
            )
        signal, saw_signal = number, True
    if not words:
        return job_result(cmd_str, builtin_usage("kill"), 2)
    processes = job_table.processes
    errors: list[str] = []
    signalled = False
    await job_table.sync(sid)
    for operand in words:
        jobs = job_table.list_jobs(sid)
        pid, refusal = _kill_pid(jobs, operand)
        shown = {job.pid: job.shown_pid for job in jobs}
        if pid is not None and 0 < pid < FIRST_PID and operand.isdigit():
            found_process, ambiguous = await machine_process(
                processes, session, pid, machine
            )
            if ambiguous:
                errors.append(f"{voice}kill: {operand}: ambiguous job spec")
                continue
            pid = found_process.pid if found_process is not None else None
            refusal = f"({operand}) - No such process"
        elif pid is not None and -FIRST_PID < pid < 0:
            leader, ambiguous = await machine_process(
                processes, session, -pid, machine
            )
            if ambiguous:
                errors.append(f"{voice}kill: {operand}: ambiguous job spec")
                continue
            pid = -leader.group if leader is not None else None
            refusal = f"({operand}) - No such process"
        elif pid is not None and pid > 0 and machine is not None:
            await processes.scan()
            if not any(
                info.pid == pid and on_machine(info, machine)
                for info in processes.visible(sid, grants_of(session))
            ):
                refusal = f"({operand}) - No such process"
                pid = None
        if pid is None:
            errors.append(f"{voice}kill: {refusal}")
            continue
        if operand.startswith("-"):
            try:
                found = await _kill_group(
                    job_table, session, jobs, -pid, signal
                )
            except PermissionError:
                errors.append(
                    f"{voice}kill: ({operand}) - Operation not permitted"
                )
                continue
            if not found:
                errors.append(f"{voice}kill: ({operand}) - No such process")
                continue
            signalled = True
            continue
        named = operand if operand.isdigit() else shown.get(pid, pid)
        try:
            found = await _signal_one(job_table, session, jobs, pid, signal)
        except PermissionError:
            errors.append(f"{voice}kill: ({named}) - Operation not permitted")
            continue
        if not found:
            errors.append(f"{voice}kill: ({named}) - No such process")
            continue
        signalled = True
    runner = current_caller().process
    if runner is not None and runner.record.state == ProcessState.STOPPING:
        # The shell running kill stopped itself (`kill $$`): the signal
        # lands here, before its next statement.
        raise asyncio.CancelledError
    code = 0 if signalled else 1
    err = encode_text("\n".join(errors) + "\n") if errors else b""
    node = ExecutionNode(command=cmd_str, exit_code=code, stderr=err)
    return None, IOResult(exit_code=code, stderr=err or None), node


async def _signal_one(
    job_table: JobTable,
    session: SessionState | None,
    jobs: list[JobHandle],
    pid: int,
    signal: int,
) -> bool:
    """Signal one process the session may reach (``ProcessTable.signal``),
    its job recorded as killed if that stopped it.

    Args:
        job_table (JobTable): the session's jobs.
        session (SessionState | None): the shell session, if any.
        jobs (list[JobHandle]): the jobs the builtin can see.
        pid (int): the process, by Mirage's own number for it.
        signal (int): the signal.

    Returns:
        bool: whether the process was there to signal.
    """
    processes = job_table.processes
    sid = session_of(session)
    handle = processes.target(pid, sid, grants_of(session))
    if handle is None:
        return False
    found = await processes.signal(handle, signal)
    job = next(
        (j for j in jobs if j.process is not None and j.pid == pid), None
    )
    if (
        found
        and job is not None
        and handle.record.state == ProcessState.STOPPING
    ):
        await job_table.kill(job.id, sid, handle.signal or signal)
    return found


async def _kill_group(
    job_table: JobTable,
    session: SessionState | None,
    jobs: list[JobHandle],
    group: int,
    signal: int,
) -> bool:
    """Signal a process group the session may reach as killpg(2) does,
    its jobs Mirage stops recorded as killed by the signal.

    Args:
        job_table (JobTable): the session's jobs.
        session (SessionState | None): the shell session, if any.
        jobs (list[JobHandle]): the jobs the builtin can see.
        group (int): the group.
        signal (int): the signal; 0 only probes.

    Returns:
        bool: whether the group had a runner the session sees.
    """
    processes = job_table.processes
    sid = session_of(session)
    granted = grants_of(session)
    if processes.group(group, sid, granted) is None:
        return False
    if signal == 0:
        return True
    await processes.scan()
    await processes.signal_members(
        processes.group(group, sid, granted) or [], signal
    )
    for job in jobs:
        if (
            job.process is not None
            and job.process.record.group == group
            and job.process.record.state == ProcessState.STOPPING
        ):
            await job_table.kill(job.id, sid, job.process.signal or signal)
    return True
