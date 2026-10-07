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
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import Any

from mirage.commands.builtin.utils.identity import UNKNOWN_NAME
from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.commands.errors import CommandTimeoutError
from mirage.context import program_invocation
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.process.types import ProcessInfo, ProcessState, ProcessView
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import (
    Channel,
    JobConsole,
    JobOutput,
    OwnedStream,
    Tee,
)
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.constants import (
    FD_BOTH,
    FD_CLOSE,
    FORK_FAILED,
    FORK_FAILED_STATUS,
)
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.shell.helpers import get_redirects, get_text, is_backgrounded
from mirage.shell.job_table import Job, JobStatus, JobTable
from mirage.shell.node_kind import NodeKind, node_kind
from mirage.shell.parse.program import retain_programs
from mirage.shell.types import TSNodeLike
from mirage.utils.timezone import zone_from_env
from mirage.workspace.evaluation import (
    EvaluationContext,
    child_context,
    reset_current_evaluation,
    set_current_evaluation,
)
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.statement import failed_read, statement_stdin
from mirage.workspace.executor.traps import inherit_exit_trap
from mirage.workspace.node.occurrence import occurrence_of
from mirage.workspace.session import (
    SessionState,
)
from mirage.workspace.types import ExecutionNode


async def pump(
    console: JobConsole, channel: Channel, stream: ByteSource | None
) -> None:
    """Send a command's output to a console as chunks arrive.

    Consuming the stream piece by piece rather than materializing it
    whole is what lets a reader watch a running job. A command that
    computes its output eagerly still lands in one chunk, because there
    was nothing to observe before it finished. A pipe is drained before
    the next chunk is pulled, so a reader that closed stops the source
    before it fetches more.

    Args:
        console (JobConsole): where the output goes.
        channel (Channel): which stream the bytes belong to.
        stream (ByteSource | None): the output to drain.
    """
    if stream is None:
        return
    if isinstance(stream, bytes):
        if stream:
            await console.emit(channel, stream)
        return
    async for chunk in stream:
        if chunk:
            await console.emit(channel, chunk)
        if not isinstance(console, PipeConsole):
            continue
        await console.drain()
        if console.closed_reader:
            await close_quietly(stream)
            return


async def drained(
    sink: JobConsole,
    stdout: ByteSource | None,
    io: IOResult,
    exec_node: ExecutionNode,
) -> tuple[None, IOResult, ExecutionNode]:
    """Write a finished statement's returned output to a sink.

    Its stdout goes before its stderr, since one command keeps no order
    between them; what it already wrote there as it ran (a function
    body, a redirected group) came first. A read its stream fails is the
    statement's own failure (``failed_read``). The result carries no
    output, so nothing lands twice.

    Args:
        sink (JobConsole): where the statement writes.
        stdout (ByteSource | None): the output it returned.
        io (IOResult): its result, its stderr emptied once written.
        exec_node (ExecutionNode): its record.
    """
    try:
        await pump(sink, Channel.STDOUT, stdout)
    except OSError as exc:
        await failed_read(io, exc, exec_node)
    stderr = await io.materialize_stderr()
    if stderr:
        await sink.emit(Channel.STDERR, stderr)
        io.stderr = None
    return None, io, exec_node


def _job_streams(
    node: TSNodeLike, session: SessionState
) -> set[Channel | OwnedStream]:
    """The streams a job started from ``node`` writes, as its shell hands
    them on: stdout, stderr and the copies the shell holds (``3>&1``),
    after the job's own redirects (``sleep 9 >/dev/null &``). A stream
    sent to a file or closed is gone.

    Args:
        node (TSNodeLike): the backgrounded command.
        session (SessionState): the shell that starts it.
    """
    fds: dict[int, Channel | OwnedStream | None] = {
        1: Channel.STDOUT,
        2: Channel.STDERR,
    }
    for fd, descriptor in session.descriptors.items():
        if fd > 2:
            fds[fd] = descriptor.stream
    if node_kind(node) == NodeKind.REDIRECT:
        for r in get_redirects(node)[1]:
            if r.target == FD_CLOSE:
                fds.pop(r.fd, None)
            elif isinstance(r.target, int):
                fds[r.fd] = fds.get(r.target)
            else:
                for fd in (1, 2) if r.fd == FD_BOTH else (r.fd,):
                    fds[fd] = None
    return {stream for stream in fds.values() if stream is not None}


async def handle_background(
    execute_node,
    left: TSNodeLike,
    right: TSNodeLike | None,
    context: EvaluationContext,
    job_table: JobTable,
    agent_id: str | None,
    stdin: ByteSource | None = None,
    call_stack=None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run left side in background.

    ``handed`` and ``decisions`` are the line's hand-off and the ledger
    it lives in. The claims the line's pass made for the commands inside
    the job are copied onto one of the job's own before the job starts
    (``Decisions.split``): its gates run after the line has returned,
    and its grants have to stay reserved through the line's end
    whichever way the line ends, a release for a question left waiting
    included, and through the launch of the same job again by a loop.
    The job's whole subtree runs on that hand-off, the lines it
    evaluates included (the walker binds it into their door), and the
    job revokes it when it ends, which spends what no other hand-off
    still holds.
    """
    session = context.session
    release_program = retain_programs([left])
    child_evaluation = child_context(context)
    bg_session = child_evaluation.session

    def release_job(_: asyncio.Task[Any] | None = None) -> None:
        release_program()

    inherit_exit_trap(bg_session)
    output = session.job_output or session.tty.jobs
    # A job is a shell of its own: what jobs it starts write into the
    # statement it runs, then where it writes.
    bg_session.job_output = JobOutput(output)
    # A job is a child shell outside every loop: `{ break; } &` in a
    # loop refuses, as bash's does.
    bg_call_stack = (call_stack or CallStack()).fork(loops=False)
    job_handed = (
        decisions.split(
            session.session_id, handed, occurrence_of(left, handed)
        )
        if handed is not None and decisions is not None
        else None
    )

    async def _run_bg(job: Job) -> tuple[IOResult, ExecutionNode]:
        # Background jobs don't receive stdin, matching real shell
        # behavior where bg processes get /dev/null. This prevents
        # race conditions when stdin is an async iterator.
        # What the job writes stays in its console and goes where its
        # shell writes as it is written: the terminal, or the
        # substitution or pipe it was started in.
        console = Tee(job.console, output)
        cmd_str_inner = get_text(left) if hasattr(left, "text") else str(left)
        # The task's context snapshot still points at the OUTER session
        # (create_task copies the context before the fork can be bound),
        # and the fork keeps its parent's id, so without this rebind a
        # nested eval inside the job resolves the ambient outer session
        # and escapes the fork.
        token = set_current_evaluation(child_evaluation)
        try:
            try:
                # Handing the console down as a sink is what makes
                # compound bodies stream: each statement writes as it
                # finishes rather than the whole construct landing at
                # the end. Statements that emit return no stdout, so the
                # pump below is a no-op for them and still covers
                # constructs that do not stream.
                # A job outlives the line that launched it and is not the
                # caller's to abort, as bash leaves a background job alone
                # on SIGINT and a TypeScript job runs under its own
                # controller: it runs without the line's event.
                stdout, io, exec_node = await execute_node(
                    left,
                    child_evaluation,
                    None,
                    bg_call_stack,
                    sink=console,
                    handed=job_handed,
                    cancel=None,
                    execution_scope=ExecutionScope(),
                    ends_shell=True,
                )
            except CommandTimeoutError as exc:
                msg = encode_text(str(exc) + "\n")
                stdout = b""
                io = IOResult(exit_code=124, stderr=msg)
                exec_node = ExecutionNode(
                    command=cmd_str_inner, stderr=msg, exit_code=124
                )
            except ExitSignal as sig:
                # A background job is its own shell: exit ends the job
                # only.
                stdout = sig.stdout or b""
                io = IOResult(
                    exit_code=sig.contained_code, stderr=sig.stderr or None
                )
                exec_node = ExecutionNode(
                    command=cmd_str_inner,
                    stderr=sig.stderr,
                    exit_code=sig.contained_code,
                )
            except ReturnSignal as sig:
                stdout = sig.stdout
                io = IOResult(
                    exit_code=sig.exit_code, stderr=sig.stderr or None
                )
                exec_node = ExecutionNode(
                    command=cmd_str_inner,
                    stderr=sig.stderr,
                    exit_code=sig.exit_code,
                )
            # Drain inside the rebind: pumping the stream can still run
            # ops that read the ambient session.
            await pump(console, Channel.STDOUT, stdout)
            stderr = await io.materialize_stderr()
            if stderr:
                await console.emit(Channel.STDERR, stderr)
            return io, exec_node
        finally:
            release_job()
            reset_current_evaluation(token)
            if job_handed is not None and decisions is not None:
                await decisions.revoke(session.session_id, job_handed)

    cmd_str = get_text(left) if hasattr(left, "text") else str(left)

    # Non-interactive bash announces nothing on launch ("[1] <pid>" is
    # interactive-only); the job stays discoverable via $! and `jobs`.
    try:
        job = job_table.submit(
            command=cmd_str,
            run=_run_bg,
            cwd=bg_session.cwd,
            agent=agent_id or "",
            session_id=session.session_id,
            parent_pid=session.process_id,
            limit=session.processes.max,
        )
    except Exception as exc:
        release_job()
        # A submission that fails (a console the table cannot build, a
        # session at its process cap) starts no runner, so nothing would
        # ever revoke the job's hand-off: its grants would stay reserved
        # for good, neither spent nor on offer to any later line.
        if job_handed is not None and decisions is not None:
            await decisions.revoke(session.session_id, job_handed)
        if isinstance(exc, BlockingIOError):
            raise ExitSignal(FORK_FAILED_STATUS, stderr=FORK_FAILED) from exc
        raise
    # A job killed before its runner starts never enters _run_bg, so its
    # leases also go when its task ends.
    if job.task is not None:
        job.task.add_done_callback(release_job)
    bg_session.process_id = (
        job.process.info.pid if job.process is not None else None
    )
    session.last_bg_job_id = job.pid
    waits = session.job_waits
    if waits is not None and waits.reaches(
        output, _job_streams(left, session)
    ):
        waits.add(job)

    if right is None:
        return (
            None,
            IOResult(),
            ExecutionNode(
                op="&",
                exit_code=0,
                children=[ExecutionNode(command=cmd_str, exit_code=0)],
            ),
        )

    right_stdout, right_io, right_exec = await execute_node(
        right, context, stdin, call_stack
    )
    children = [
        ExecutionNode(command=cmd_str, exit_code=0),
        right_exec,
    ]
    return (
        right_stdout,
        right_io,
        ExecutionNode(op="&", exit_code=right_io.exit_code, children=children),
    )


async def run_statement(
    execute_node: Callable[..., Any],
    node: TSNodeLike,
    context: EvaluationContext,
    stdin: ByteSource | None,
    bound: tuple[SharedInput | None, bool],
    call_stack: CallStack | None,
    job_table: JobTable | None,
    agent_id: str | None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run one statement of a compound body, as a job when it ends in ``&``.

    The program loop and the subshell body read the ``&`` off the token
    stream themselves; a loop body, an if/case arm, a brace group or a
    function body holds named nodes only, so the statement is asked
    about its own terminator. The launch is a statement in its own
    right and answers with status 0, as in bash, so ``false &`` inside
    a body trips neither ``$?`` nor ``set -e``.

    Args:
        execute_node (Callable): the executor's statement runner.
        node (TSNodeLike): the statement.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): the body's input; a job gets none,
            like a background process reading /dev/null.
        bound (tuple[SharedInput | None, bool]): ``fd0_binding`` as the
            body started, so an ``exec <`` in it replaces ``stdin``.
        call_stack (CallStack | None): function-call scope, if any.
        job_table (JobTable | None): where the job lives. None means
            the caller wired no job plane, which is a programming
            error once a ``&`` shows up, not a reason to run inline.
        agent_id (str | None): agent identity for job bookkeeping.
        handed (HandOff | None): approval claims inherited by a job.
        decisions (Decisions | None): ledger that holds those claims.
    """
    session = context.session
    if not is_backgrounded(node):
        return await execute_node(
            node, context, statement_stdin(session, stdin, bound), call_stack
        )
    if job_table is None:
        raise RuntimeError(
            f"`{get_text(node)} &` needs a job table; none was wired"
        )
    return await handle_background(
        execute_node,
        node,
        None,
        context,
        job_table,
        agent_id,
        stdin,
        call_stack,
        handed,
        decisions,
    )


_WAIT_USAGE = "wait: usage: wait [-fn] [-p var] [id ...]"
_DISOWN_USAGE = "disown: usage: disown [-h] [-ar] [jobspec ... | pid ...]"
_JOB_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _job_result(
    cmd_str: str, msg: str, code: int
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    err = encode_text(msg)
    return (
        None,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err),
    )


def _session_of(session: SessionState | None) -> str:
    """The job list a builtin reads: the calling session's, or the shared
    empty id when it runs with no session (a bare table in a test).

    Args:
        session (SessionState | None): the shell session, if any.
    """
    return session.session_id if session is not None else ""


def _process_view(
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


def _job_numbered(jobs: list[Job], job_id: int) -> Job | None:
    """The job whose number is `job_id`, the one `%N` names.

    Args:
        jobs (list[Job]): the jobs the builtin can see.
        job_id (int): the job number.
    """
    return next((j for j in jobs if j.id == job_id), None)


def _resolve_spec(jobs: list[Job], spec: str) -> tuple[Job | None, str]:
    """The job a `wait`/`disown` operand names, or bash's refusal.

    A `%N` spec that names no job is `no such job`; a bare number is a
    managed PID, also returned by `$!`, so a bare number that names no
    job is bash's `pid N is not a child of this shell`. Anything else
    is `not a pid or valid job spec`.

    Args:
        jobs (list[Job]): the jobs the builtin can see.
        spec (str): the operand as typed.
    """
    if spec.startswith("%"):
        raw = spec[1:]
        job = _job_numbered(jobs, int(raw)) if raw.isdigit() else None
        return job, "" if job is not None else f"{spec}: no such job"
    if spec.isdigit():
        job = next((j for j in jobs if j.pid == int(spec)), None)
        return job, "" if job is not None else (
            f"pid {spec} is not a child of this shell"
        )
    return None, f"`{spec}': not a pid or valid job spec"


async def _wait_first(job_table: JobTable, jobs: list[Job]) -> Job:
    """Block until the first of several jobs ends, and return it.

    Args:
        job_table (JobTable): the session's jobs.
        jobs (list[Job]): the candidates, all present in the table.
    """
    for job in jobs:
        if job.status != JobStatus.RUNNING:
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


def _reaped(
    job_table: JobTable, job: Job, cmd_str: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Report one finished job's status, and reap it.

    Its output already went where its shell writes as it was written.

    Args:
        job_table (JobTable): the session's jobs.
        job (Job): the job, already finished.
        cmd_str (str): the command line, for the node.
    """
    # Reaped like GNU bash reaps a job waited on by id, so a later bare
    # `wait` does not answer for it again.
    job_table.reap(job.id, job.session_id)
    return (
        None,
        IOResult(exit_code=job.exit_code),
        ExecutionNode(command=cmd_str, exit_code=job.exit_code),
    )


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
    `-f` is accepted, since a mirage job cannot stop, only end.

    `-p` stores the managed PID, matching `$!` and `jobs -p`.
    A spec naming no job is bash's own message and 127; a word that is
    neither is `not a pid or valid job spec` and 1.

    Args:
        job_table (JobTable): the session's jobs.
        parts (list[str]): the command words, `wait` first.
        session (SessionState | None): shell session state, for `-p`.
        view (SessionView | None): the session plane's gated door.
    """
    cmd_str = " ".join(parts)
    sid = _session_of(session)
    next_job = False
    var: str | None = None
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
            elif ch == "p":
                rest = word[j + 1 :]
                if rest:
                    var = rest
                elif i + 1 < len(parts):
                    i += 1
                    var = parts[i]
                else:
                    return _job_result(
                        cmd_str,
                        f"bash: wait: -p: option requires an "
                        f"argument\n{_WAIT_USAGE}\n",
                        2,
                    )
                break
            else:
                return _job_result(
                    cmd_str,
                    f"bash: wait: -{ch}: invalid option\n{_WAIT_USAGE}\n",
                    2,
                )
            j += 1
        i += 1
    if var is not None:
        if _JOB_IDENTIFIER.fullmatch(var) is None:
            return _job_result(
                cmd_str, f"bash: wait: `{var}': not a valid identifier\n", 1
            )
        if view is not None and view.is_readonly(var):
            return _job_result(
                cmd_str,
                f"bash: wait: {var}: cannot unset: readonly variable\n",
                1,
            )
        if view is not None:
            await view.unset(var)
    errors: list[str] = []
    picked: list[Job] = []
    visible = job_table.list_jobs(sid)
    for spec in specs:
        job, refusal = _resolve_spec(visible, spec)
        if job is None:
            errors.append(f"bash: wait: {refusal}")
            continue
        picked.append(job)
    err_text = ("\n".join(errors) + "\n") if errors else ""
    if next_job:
        candidates = picked if specs else visible
        if not candidates:
            # Nothing to wait for: the specs were all bad, or there are
            # no jobs. bash reports any bad spec and answers 127.
            code = 127
            return (
                None,
                IOResult(exit_code=code, stderr=encode_text(err_text) or None),
                ExecutionNode(command=cmd_str, exit_code=code),
            )
        job = await _wait_first(job_table, candidates)
        if var is not None and view is not None:
            await view.set(var, str(job.pid))
        stdout, io, node = _reaped(job_table, job, cmd_str)
        if err_text:
            io.stderr = encode_text(err_text)
        return stdout, io, node
    if not specs:
        await job_table.wait_all(sid)
        job_table.pop_completed(sid)
        return None, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)
    if not picked:
        # Every spec was refused: bash answers 127 for a job it cannot
        # find and 1 for a word that is not a spec at all, the last
        # refusal deciding.
        last = errors[-1]
        code = 1 if last.endswith("not a pid or valid job spec") else 127
        return _job_result(cmd_str, err_text, code)
    last_code = 0
    last_job: Job | None = None
    for job in picked:
        finished = await job_table.wait(job.id, sid)
        _, io, _ = _reaped(job_table, finished, cmd_str)
        last_code = io.exit_code
        last_job = finished
    # `wait id1 id2` answers with the last id's status, so `-p` names
    # that same job however many were waited for. Only the no-operand
    # form leaves the variable unset, since it reports no one job.
    if var is not None and view is not None and last_job is not None:
        await view.set(var, str(last_job.pid))
    return (
        None,
        IOResult(exit_code=last_code, stderr=encode_text(err_text) or None),
        ExecutionNode(command=cmd_str, exit_code=last_code),
    )


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
    sid = _session_of(session)
    scan = scan_options(parts[1:], "arh")
    if scan.bad is not None:
        return _job_result(
            cmd_str,
            f"bash: disown: {scan.bad}: invalid option\n{_DISOWN_USAGE}\n",
            2,
        )
    all_jobs = "a" in scan.letters
    running_only = "r" in scan.letters
    keep = "h" in scan.letters
    specs = scan.operands
    targets: list[Job] = []
    errors: list[str] = []
    jobs = job_table.list_jobs(sid)
    if specs:
        for spec in specs:
            job, _ = _resolve_spec(jobs, spec)
            if job is None:
                errors.append(f"bash: disown: {spec}: no such job")
                continue
            targets.append(job)
    elif all_jobs or running_only:
        targets = (
            [j for j in jobs if j.status == JobStatus.RUNNING]
            if running_only
            else jobs
        )
    else:
        if not jobs:
            return _job_result(
                cmd_str, "bash: disown: current: no such job\n", 1
            )
        targets = [jobs[-1]]
    if not keep:
        for job in targets:
            job_table.disown(job.id, sid)
    err = encode_text("\n".join(errors) + "\n") if errors else None
    code = 1 if errors else 0
    return (
        None,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )


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
        view (SessionView | None): the session plane's gated door.
        sink (JobConsole | None): where the statement writes, so the
            command line is there before the job's next bytes.
    """
    cmd_str = " ".join(parts)
    sid = _session_of(session)
    jobs = job_table.list_jobs(sid)
    if len(parts) <= 1:
        if not jobs:
            err = b"bash: fg: current: no such job\n"
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
            )
        running = [j for j in jobs if j.status == JobStatus.RUNNING]
        target = (running or jobs)[-1]
    else:
        raw = parts[1].lstrip("%")
        try:
            job_id = int(raw)
        except ValueError:
            err = encode_text(f"bash: fg: {parts[1]}: no such job\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
            )
        numbered = _job_numbered(jobs, job_id)
        if numbered is None:
            err = encode_text(f"bash: fg: {parts[1]}: no such job\n")
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
    job_table.reap(target.id, sid)
    return (
        header if sink is None else None,
        IOResult(exit_code=job.exit_code),
        ExecutionNode(command=cmd_str, exit_code=job.exit_code),
    )


_KILL_USAGE = (
    "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | "
    "jobspec ... or kill -l [sigspec]"
)

# The signals a managed runner answers besides the probe (0). Each one ends
# the runner through its cancellation channel, so the waited status is the
# managed cancellation's (137) whichever was sent. Stop, continue and the
# user signals have no managed meaning and are refused as bash refuses a
# name it does not know.
_KILL_SIGNALS = {"HUP": 1, "INT": 2, "QUIT": 3, "KILL": 9, "TERM": 15}

# The largest PID operand kill and ps read as a number: the bound both hosts
# hold exactly (bash's own is intmax_t).
_MAX_PID_OPERAND = 2**53 - 1


def _signal_number(spec: str) -> int | None:
    """bash's sigspec: a number, or a name with or without SIG, any case.

    Args:
        spec (str): the sigspec as typed.
    """
    if spec.isascii() and spec.isdigit():
        number = int(spec)
        known = number == 0 or number in _KILL_SIGNALS.values()
        return number if known else None
    name = spec.upper()
    return _KILL_SIGNALS.get(name[3:] if name.startswith("SIG") else name)


def _kill_pid(jobs: list[Job], operand: str) -> tuple[int | None, str]:
    """The managed PID one kill operand names, or bash's refusal.

    Args:
        jobs (list[Job]): the jobs the builtin can see.
        operand (str): the operand as typed.
    """
    if operand == "":
        return None, "`': not a pid or valid job spec"
    if operand.startswith("%"):
        raw = operand[1:]
        job = _job_numbered(jobs, int(raw)) if raw.isdigit() else None
        if job is None:
            return None, f"{operand}: no such job"
        return job.pid, ""
    digits = operand[1:] if operand.startswith("-") else operand
    if (
        not digits.isascii()
        or not digits.isdigit()
        or int(digits) > _MAX_PID_OPERAND
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
    ``0`` probes and every other signal cancels the runner. Every
    operand is tried and each failure is named in bash's words; the
    status is 0 when any operand was signalled, as bash's is. A job
    spec is ``%N``; a negative number is a process group, which no
    managed runner leads.

    Args:
        job_table (JobTable): the session's jobs.
        parts (list[str]): the command words, `kill` first.
        session (SessionState | None): the shell session, if any.
        view (SessionView | None): the session plane's gated door.
    """
    cmd_str = " ".join(parts)
    sid = _session_of(session)
    signal = _KILL_SIGNALS["TERM"]
    words = parts[1:]
    saw_signal = False
    voice = (
        "" if session is not None and program_invocation(session) else "bash: "
    )
    while words:
        word = words[0]
        if word in ("-s", "-n"):
            if len(words) < 2:
                return _job_result(
                    cmd_str,
                    f"{voice}kill: {word}: option requires an argument\n",
                    1,
                )
            spec, words = words[1], words[2:]
        elif word == "--":
            words = words[1:]
            break
        elif word == "-?":
            return _job_result(cmd_str, f"{_KILL_USAGE}\n", 2)
        elif word.startswith("-") and len(word) > 1 and not saw_signal:
            spec, words, saw_signal = word[1:], words[1:], True
        else:
            break
        number = _signal_number(spec)
        if number is None:
            return _job_result(
                cmd_str,
                f"{voice}kill: {spec}: invalid signal specification\n",
                1,
            )
        signal = number
    if not words:
        return _job_result(cmd_str, f"{_KILL_USAGE}\n", 2)
    processes = _process_view(job_table, session)
    errors: list[str] = []
    signalled = False
    for operand in words:
        jobs = job_table.list_jobs(sid)
        pid, refusal = _kill_pid(jobs, operand)
        if pid is None:
            errors.append(f"{voice}kill: {refusal}")
            continue
        try:
            if signal == 0:
                found = processes.probe(pid)
            else:
                found = processes.terminate(pid)
                job = next((j for j in jobs if j.pid == pid), None)
                if found and job is not None:
                    await job_table.kill(job.id, sid)
        except PermissionError:
            errors.append(f"{voice}kill: ({pid}) - Operation not permitted")
            continue
        if not found:
            errors.append(f"{voice}kill: ({pid}) - No such process")
            continue
        signalled = True
    code = 0 if signalled else 1
    err = encode_text("\n".join(errors) + "\n") if errors else b""
    node = ExecutionNode(command=cmd_str, exit_code=code, stderr=err)
    return None, IOResult(exit_code=code, stderr=err or None), node


_JOBS_FLAGS = frozenset("lnprs")
_JOBS_USAGE = (
    "jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]"
)


def _job_row(job: Job, long: bool) -> str:
    """One `jobs` line in mirage's own row shape.

    Args:
        job (Job): the job.
        long (bool): `-l`, which includes the managed process id.
    """
    if long:
        return f"[{job.id}] {job.pid} {job.status.value} {job.command}"
    return f"[{job.id}] {job.status.value} {job.command}"


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
    sid = _session_of(session)
    flags: set[str] = set()
    specs: list[str] = []
    for word in parts[1:]:
        if word.startswith("-") and len(word) > 1 and not specs:
            if word == "--":
                continue
            bad = next((c for c in word[1:] if c not in _JOBS_FLAGS), None)
            if bad is not None:
                err = encode_text(
                    f"bash: jobs: -{bad}: invalid option\n{_JOBS_USAGE}\n"
                )
                return (
                    None,
                    IOResult(exit_code=2, stderr=err),
                    ExecutionNode(command=cmd_str, exit_code=2, stderr=err),
                )
            flags.update(word[1:])
        else:
            specs.append(word)
    jobs = job_table.listing(sid)
    if specs:
        picked: list[Job] = []
        for spec in specs:
            raw = spec.lstrip("%")
            job = _job_numbered(jobs, int(raw)) if raw.isdigit() else None
            if job is None:
                err = encode_text(f"bash: jobs: {spec}: no such job\n")
                return (
                    None,
                    IOResult(exit_code=1, stderr=err),
                    ExecutionNode(command=cmd_str, exit_code=1, stderr=err),
                )
            picked.append(job)
        jobs = picked
    if "r" in flags:
        jobs = [j for j in jobs if j.status == JobStatus.RUNNING]
    if "s" in flags:
        jobs = []
    if "n" in flags:
        jobs = [j for j in jobs if j.status != JobStatus.RUNNING]
    if "p" in flags:
        lines = [str(j.pid) for j in jobs]
    else:
        lines = [_job_row(j, "l" in flags) for j in jobs]
    job_table.pop_completed(sid)
    out = encode_text("\n".join(lines) + "\n") if lines else b""
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)


# procps-ng 4.0.4's usage block, printed under every option error.
_PS_USAGE = (
    "\nUsage:\n ps [options]\n\n"
    " Try 'ps --help <simple|list|output|threads|misc|all>'\n"
    "  or 'ps --help <s|l|o|t|m|a>'\n"
    " for additional help text.\n\n"
    "For more details see ps(1).\n"
)

# procps-ng 4.0.4's -o keys: header, width, right alignment and the fact
# ``_ps_cell`` renders; accounting a runner lacks prints procps's none.
_PS_COLUMNS: dict[str, tuple[str, int, bool, str]] = {
    "pid": ("PID", 7, True, "pid"),
    "tgid": ("TGID", 7, True, "pid"),
    "lwp": ("LWP", 7, True, "pid"),
    "spid": ("SPID", 7, True, "pid"),
    "tid": ("TID", 7, True, "pid"),
    "ppid": ("PPID", 7, True, "ppid"),
    "pgid": ("PGID", 7, True, "pgid"),
    "pgrp": ("PGRP", 7, True, "pgid"),
    "sid": ("SID", 7, True, "sid"),
    "sess": ("SESS", 7, True, "sid"),
    "tpgid": ("TPGID", 7, True, "tpgid"),
    "stat": ("STAT", 4, False, "stat"),
    "state": ("S", 1, False, "state"),
    "s": ("S", 1, False, "state"),
    "cmd": ("CMD", 27, False, "args"),
    "args": ("COMMAND", 27, False, "args"),
    "command": ("COMMAND", 27, False, "args"),
    "comm": ("COMMAND", 15, False, "comm"),
    "ucmd": ("CMD", 15, False, "comm"),
    "ucomm": ("COMMAND", 15, False, "comm"),
    "user": ("USER", 8, False, "user"),
    "euser": ("EUSER", 8, False, "user"),
    "uname": ("USER", 8, False, "user"),
    "ruser": ("RUSER", 8, False, "user"),
    "suser": ("SUSER", 8, False, "user"),
    "fuser": ("FUSER", 8, False, "user"),
    "uid": ("UID", 5, True, "user"),
    "euid": ("EUID", 5, True, "user"),
    "ruid": ("RUID", 5, True, "user"),
    "suid": ("SUID", 5, True, "user"),
    "fuid": ("FUID", 5, True, "user"),
    "gid": ("GID", 5, True, "group"),
    "egid": ("EGID", 5, True, "group"),
    "rgid": ("RGID", 5, True, "group"),
    "group": ("GROUP", 8, False, "group"),
    "egroup": ("EGROUP", 8, False, "group"),
    "rgroup": ("RGROUP", 8, False, "group"),
    "tty": ("TT", 8, False, "tty"),
    "tt": ("TT", 8, False, "tty"),
    "tname": ("TTY", 8, False, "tty"),
    "time": ("TIME", 8, True, "time"),
    "cputime": ("TIME", 8, True, "time"),
    "cputimes": ("TIME", 8, True, "zero"),
    "etime": ("ELAPSED", 11, True, "etime"),
    "etimes": ("ELAPSED", 7, True, "etimes"),
    "lstart": ("STARTED", 24, True, "lstart"),
    "start": ("STARTED", 8, True, "start"),
    "start_time": ("START", 5, False, "stime"),
    "stime": ("STIME", 5, False, "stime"),
    "bsdstart": ("START", 6, True, "bsdstart"),
    "rss": ("RSS", 5, True, "zero"),
    "rssize": ("RSS", 5, True, "zero"),
    "rsz": ("RSZ", 5, True, "zero"),
    "vsz": ("VSZ", 6, True, "zero"),
    "vsize": ("VSZ", 6, True, "zero"),
    "sz": ("SZ", 5, True, "zero"),
    "trs": ("TRS", 4, True, "zero"),
    "drs": ("DRS", 5, True, "zero"),
    "dsiz": ("DSIZ", 4, True, "zero"),
    "size": ("SIZE", 5, True, "zero"),
    "pss": ("PSS", 5, True, "zero"),
    "uss": ("USS", 5, True, "zero"),
    "maj_flt": ("MAJFL", 6, True, "zero"),
    "min_flt": ("MINFL", 6, True, "zero"),
    "majflt": ("MAJFLT", 6, True, "zero"),
    "minflt": ("MINFLT", 6, True, "zero"),
    "%cpu": ("%CPU", 4, True, "percent"),
    "pcpu": ("%CPU", 4, True, "percent"),
    "%mem": ("%MEM", 4, True, "percent"),
    "pmem": ("%MEM", 4, True, "percent"),
    "c": ("C", 2, True, "zero"),
    "cp": ("CP", 3, True, "zero"),
    "ni": ("NI", 3, True, "zero"),
    "nice": ("NI", 3, True, "zero"),
    "pri": ("PRI", 3, True, "pri"),
    "priority": ("PRI", 3, True, "priority"),
    "opri": ("PRI", 3, True, "opri"),
    "rtprio": ("RTPRIO", 6, True, "dash"),
    "cls": ("CLS", 3, True, "cls"),
    "class": ("CLS", 3, False, "cls"),
    "policy": ("POL", 3, False, "cls"),
    "psr": ("PSR", 3, True, "zero"),
    "nlwp": ("NLWP", 4, True, "one"),
    "thcount": ("THCNT", 5, True, "one"),
    "f": ("F", 1, False, "zero"),
    "flag": ("F", 1, False, "zero"),
    "flags": ("F", 1, False, "zero"),
    "wchan": ("WCHAN", 6, False, "dash"),
    "nwchan": ("WCHAN", 6, True, "dash"),
    "label": ("LABEL", 31, False, "dash"),
}
# The fixed answers for a runner: what procps prints for a process on no
# terminal, never scheduled away from the default policy and priority.
_PS_FIXED = {
    "tpgid": "-1",
    "tty": "?",
    "time": "00:00:00",
    "zero": "0",
    "one": "1",
    "percent": "0.0",
    "pri": "19",
    "priority": "20",
    "opri": "80",
    "dash": "-",
    "cls": "TS",
}
# A runner's state letter: live, being cancelled (still unwinding), or
# exited and not yet reaped.
_PS_STATES = {
    ProcessState.RUNNING: "R",
    ProcessState.STOPPING: "R",
    ProcessState.EXITED: "Z",
}

# Letters that select every process: SysV -e/-A/-a/-x, BSD a/x.
_PS_ALL = frozenset("eAax")


@dataclass(frozen=True, slots=True)
class _PsOptions:
    """What a ps line selects and prints.

    Args:
        pids (frozenset[int]): ``-p`` selection, empty for none.
        all (bool): a letter that selects every process was given.
        columns (tuple[tuple[str, str], ...]): ``-o`` keys and headers.
    """

    pids: frozenset[int]
    all: bool
    columns: tuple[tuple[str, str], ...]


def _ps_pids(value: str, option: str) -> set[int]:
    """One ``-p`` list, refused in procps's words.

    Args:
        value (str): the list, comma or blank separated.
        option (str): the option as typed, for the missing-list error.
    """
    tokens = value.replace(",", " ").split()
    if not tokens:
        raise ValueError(f"list of process IDs must follow {option}")
    pids: set[int] = set()
    for token in tokens:
        body = token[1:] if token[:1] in "+-" else token
        if not body.isascii() or not body.isdigit():
            raise ValueError("process ID list syntax error")
        number = int(token)
        if number <= 0 or number > _MAX_PID_OPERAND:
            raise ValueError("process ID out of range")
        pids.add(number)
    return pids


def _ps_columns(value: str, option: str) -> list[tuple[str, str]]:
    """One ``-o`` list: ``key`` or ``key=header``, refused in procps's words.

    Args:
        value (str): the format list, comma or blank separated.
        option (str): the option as typed, for the missing-list error.
    """
    if not value.strip():
        raise ValueError(f"format specification must follow {option}")
    columns: list[tuple[str, str]] = []
    for item in value.split(","):
        if not item.strip():
            raise ValueError("improper format list")
        for token in item.split():
            key, equal, header = token.partition("=")
            if key not in _PS_COLUMNS:
                raise ValueError(
                    f'unknown user-defined format specifier "{key}"'
                )
            columns.append((key, header if equal else _PS_COLUMNS[key][0]))
    return columns


def _parse_ps(words: list[str]) -> _PsOptions:
    """Parse the procps selection and output options a runner answers.

    SysV letters after one dash, BSD letters with none, and the
    ``--pid``/``--format`` long forms; ``-p`` and ``-o`` repeat and
    accumulate. ``-f`` and BSD ``u``/``w``/``f`` pick a layout the
    managed rows do not have, so they leave the compact one.

    Args:
        words (list[str]): arguments after ps.
    """
    pids: set[int] = set()
    columns: list[tuple[str, str]] = []
    select_all = False
    at = 0
    while at < len(words):
        word = words[at]
        at += 1
        if word.startswith("--"):
            option, equal, attached = word.partition("=")
            if option not in ("--pid", "--format"):
                raise ValueError("unknown gnu long option")
            if not equal:
                attached = words[at] if at < len(words) else ""
                at += 1
            if option == "--pid":
                pids |= _ps_pids(attached, option)
            else:
                columns += _ps_columns(attached, option)
            continue
        if not word.startswith("-"):
            if not word or any(letter not in "auxwf" for letter in word):
                raise ValueError("unsupported option (BSD syntax)")
            select_all = select_all or any(letter in "ax" for letter in word)
            continue
        letters = word[1:]
        while letters:
            flag, letters = letters[0], letters[1:]
            if flag in _PS_ALL:
                select_all = True
                continue
            if flag == "f":
                continue
            if flag not in "po":
                raise ValueError("unsupported SysV option")
            value, letters = letters, ""
            if not value:
                value = words[at] if at < len(words) else ""
                at += 1
            if flag == "p":
                pids |= _ps_pids(value, "-p")
            else:
                columns += _ps_columns(value, "-o")
    return _PsOptions(frozenset(pids), select_all, tuple(columns))


def _ps_row(keys: list[str], cells: list[str]) -> str:
    """One row in procps's layout: each column padded but the last.

    Args:
        keys (list[str]): the column keys, in output order.
        cells (list[str]): the rendered cells, one per key.
    """
    out: list[str] = []
    for at, (key, cell) in enumerate(zip(keys, cells)):
        _, width, right, _ = _PS_COLUMNS[key]
        if right:
            out.append(cell.rjust(width))
        elif at == len(keys) - 1:
            out.append(cell)
        else:
            out.append(cell.ljust(width))
    return " ".join(out)


@dataclass(frozen=True, slots=True)
class _PsContext:
    """What every row of one ps line reads besides its runner.

    Args:
        now (float): the moment ps runs, epoch seconds.
        zone (tzinfo | None): the zone times print in, the session's TZ.
        user (str | None): the workspace user, every runner's owner.
        group (str | None): the session's profile, the runners' group.
        session_id (str): the calling session.
        shell_pid (int | None): the calling session's ``$$``.
    """

    now: float
    zone: tzinfo | None
    user: str | None
    group: str | None
    session_id: str
    shell_pid: int | None


def _elapsed(seconds: int) -> str:
    """procps's etime: ``[[DD-]hh:]mm:ss``.

    Args:
        seconds (int): time since the runner started.
    """
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f"{days}-{hours:02d}:{minutes:02d}:{secs:02d}"
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _started(fact: str, info: ProcessInfo, ctx: _PsContext) -> str:
    """One start-time column, procps's pr_lstart, pr_start, pr_stime or
    pr_bsdstart: a day-old start prints its date, a recent one its clock.

    Args:
        fact (str): lstart, start, stime or bsdstart.
        info (ProcessInfo): the runner.
        ctx (_PsContext): the line's shared facts.
    """
    start = datetime.fromtimestamp(info.started_at, ctx.zone)
    if fact == "lstart":
        return gnu_strftime(start, "%a %b %e %H:%M:%S %Y")
    old = ctx.now - info.started_at > 86400
    if fact == "start":
        return gnu_strftime(start, "  %b %d" if old else "%H:%M:%S")
    if fact == "bsdstart":
        return gnu_strftime(start, "%b %e" if old else "%H:%M")
    now = datetime.fromtimestamp(ctx.now, ctx.zone)
    if now.year != start.year:
        return gnu_strftime(start, "%Y")
    if now.timetuple().tm_yday != start.timetuple().tm_yday:
        return gnu_strftime(start, "%b%d")
    return gnu_strftime(start, "%H:%M")


def _ps_cell(key: str, info: ProcessInfo, ctx: _PsContext) -> str:
    """One -o cell for a managed runner.

    The owner columns print the workspace user and the session's
    profile, names in the id columns too, as ``id`` does, and ``-``
    where nobody claimed one or the runner is another session's, whose
    profile this one cannot name. A runner of the calling session belongs
    to the session ``$$`` leads; another session's to its own group.

    Args:
        key (str): the column key.
        info (ProcessInfo): the runner.
        ctx (_PsContext): the line's shared facts.
    """
    fact = _PS_COLUMNS[key][3]
    if fact in _PS_FIXED:
        return _PS_FIXED[fact]
    session = (
        ctx.shell_pid
        if info.session_id == ctx.session_id and ctx.shell_pid is not None
        else info.group_id or info.pid
    )
    if fact == "pid":
        return str(info.pid)
    if fact == "ppid":
        return str(info.parent_pid or 0)
    if fact == "pgid":
        return str(info.group_id or info.pid)
    if fact == "sid":
        return str(session)
    if fact in ("stat", "state"):
        state = _PS_STATES[info.state]
        return state + ("s" if fact == "stat" and info.pid == session else "")
    if fact == "comm":
        head = info.command.split()[0] if info.command.split() else ""
        return head.rsplit("/", 1)[-1][:15]
    if fact == "user":
        return ctx.user or UNKNOWN_NAME
    if fact == "group":
        own = info.session_id == ctx.session_id
        return (ctx.group if own else None) or UNKNOWN_NAME
    elapsed = max(0, int(ctx.now - info.started_at))
    if fact == "etime":
        return _elapsed(elapsed)
    if fact == "etimes":
        return str(elapsed)
    if fact in ("lstart", "start", "stime", "bsdstart"):
        return _started(fact, info, ctx)
    return info.command


async def handle_ps(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
    user: str | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """List managed runners with procps's selection and ``-o`` columns.

    A runner has no CPU, RSS or TTY accounting, so without ``-o`` the
    rows stay mirage's compact ``PID<TAB>COMMAND`` and never broaden the
    profile's view. ``-o`` lays out procps-ng 4.0.4's columns, every key
    a runner can answer (``_PS_COLUMNS``); a header row prints unless
    every header is empty. Selecting nothing (``-p`` of an absent PID)
    exits 1, as procps does, and an option error is procps's message and
    usage.

    Args:
        job_table (JobTable): the workspace's job table.
        parts (list[str]): the command words, `ps` first.
        session (SessionState | None): the shell session, if any.
        view (SessionView | None): the session plane's gated door.
        user (str | None): the workspace user, who owns every runner.
    """
    cmd_str = " ".join(parts)
    try:
        options = _parse_ps(parts[1:])
    except ValueError as exc:
        return _job_result(cmd_str, f"error: {exc}\n{_PS_USAGE}", 1)
    processes = [
        info
        for info in _process_view(job_table, session).list()
        if options.all or not options.pids or info.pid in options.pids
    ]
    if options.columns:
        keys = [key for key, _ in options.columns]
        ctx = _PsContext(
            now=time.time(),
            zone=zone_from_env(session.env) if session is not None else None,
            user=user,
            group=session.profile if session is not None else None,
            session_id=_session_of(session),
            shell_pid=session.shell_pid if session is not None else None,
        )
        lines = [
            _ps_row(keys, [_ps_cell(key, info, ctx) for key in keys])
            for info in processes
        ]
        if any(header for _, header in options.columns):
            lines.insert(0, _ps_row(keys, [h for _, h in options.columns]))
    else:
        lines = [f"{info.pid}\t{info.command}" for info in processes]
    code = 0 if processes else 1
    out = encode_text("\n".join(lines) + "\n") if lines else b""
    return (
        out,
        IOResult(exit_code=code),
        ExecutionNode(command=cmd_str, exit_code=code),
    )
