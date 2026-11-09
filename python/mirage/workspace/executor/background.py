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
import logging
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Sequence,
)
from contextlib import aclosing
from dataclasses import replace
from typing import Any

from mirage.bridge.sync import soon
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.errors.types import CommandTimeoutError
from mirage.execution.context import new_line_id
from mirage.execution.job import JobHandle, JobState, JobTable
from mirage.execution.job.constants import (
    ENDING_SIGNALS,
    STOP_WAIT_SECONDS,
)
from mirage.execution.line.handle import LineHandle
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.execution.process.types import ProcessRunner
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput, hold_inputs
from mirage.io.errors import PipeClosed
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource
from mirage.machine.constants import RUN_START_WAIT_SECONDS
from mirage.policy.builtin.output_cap import LINE_NAME
from mirage.policy.decisions import Decisions, is_pending
from mirage.policy.types import HandOff
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
    SHELL_IGNORED_SIGNALS,
    TIMEOUT_STATUS,
)
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.shell.helpers import (
    get_pipeline_stages,
    get_redirects,
    get_text,
    is_backgrounded,
)
from mirage.shell.node_kind import NodeKind, node_kind, simple_command
from mirage.shell.parse.names import command_invocations
from mirage.shell.parse.program import retain_programs
from mirage.shell.signals import (
    signal_report,
    signal_reported,
)
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.shell.voice import shell_voice
from mirage.types import PathSpec, Refusal
from mirage.workspace.evaluation import EvaluationContext, child_context
from mirage.workspace.executor.builtins.jobspec import session_of
from mirage.workspace.executor.statement import (
    answer_closed,
    failed_read,
    forks,
    interleaved,
    nested_shell,
    record_status,
    reported_command,
    statement_stdin,
)
from mirage.workspace.executor.traps import inherit_traps
from mirage.workspace.frame import ExecutionFrame
from mirage.workspace.lookup.constants import CAPTURABLE_BUILTINS, SHELL_NAMES
from mirage.workspace.node.occurrence import occurrence_of
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


async def tagged(
    channel: Channel, stream: AsyncIterator[bytes]
) -> AsyncGenerator[tuple[Channel, bytes], None]:
    """``stream``'s chunks, each with the channel they go out on.

    Args:
        channel (Channel): the channel.
        stream (AsyncIterator[bytes]): the output.
    """
    async for chunk in stream:
        yield channel, chunk


async def pump(
    console: JobConsole,
    channel: Channel,
    stream: ByteSource | None,
    io: IOResult | None = None,
) -> None:
    """Send a command's output to a console as chunks arrive.

    Consuming the stream piece by piece rather than materializing it
    whole is what lets a reader watch a running job. A command that
    computes its output eagerly still lands in one chunk, because there
    was nothing to observe before it finished. A pipe is drained before
    the next chunk is pulled, so a reader that closed stops the source
    before it fetches more; a source that reads nothing to make its
    bytes (``OutputStream.eager``) runs ahead into the pipe's buffer, as
    bash's ``seq 1 | sleep 30`` writer does and exits. A write that fails
    closes the source too, as TypeScript's ``for await`` does. With
    ``io``, the stderr the command writes as its stream is read goes out
    among the chunks (``interleaved``); the rest stays on ``io``.

    Args:
        console (JobConsole): where the output goes.
        channel (Channel): which stream the bytes belong to.
        stream (ByteSource | None): the output to drain.
        io (IOResult | None): the result whose stderr the stream writes.
    """
    if stream is None:
        return
    if isinstance(stream, bytes):
        if stream:
            await console.emit(channel, stream)
        return
    eager = isinstance(stream, OutputStream) and stream.eager
    pairs = (
        interleaved(stream, io) if io is not None else tagged(channel, stream)
    )
    try:
        async with aclosing(pairs) as parts:
            async for part_channel, chunk in parts:
                if chunk:
                    await console.emit(part_channel, chunk)
                if part_channel != channel or not isinstance(
                    console, PipeConsole
                ):
                    continue
                if not eager:
                    await console.drain()
                if console.closed_reader:
                    return
    finally:
        await close_quietly(stream)


async def drained(
    sink: JobConsole,
    stdout: ByteSource | None,
    io: IOResult,
    exec_node: ExecutionNode,
) -> tuple[None, IOResult, ExecutionNode]:
    """Write a finished statement's returned output to a sink.

    Its stderr goes among its stdout as the stream wrote it, the rest
    after (``interleaved``); what it already wrote there as it ran (a
    function body, a redirected group) came first. A read its stream fails is the
    statement's own failure (``failed_read``). The result carries no
    output, so nothing lands twice.

    Args:
        sink (JobConsole): where the statement writes.
        stdout (ByteSource | None): the output it returned.
        io (IOResult): its result, its stderr emptied once written.
        exec_node (ExecutionNode): its record.
    """
    try:
        await pump(sink, Channel.STDOUT, stdout, io)
    except OSError as exc:
        await failed_read(io, exc, exec_node)
    except PipeClosed:
        # SIGPIPE keeps what the writer already said on stderr (`cat
        # /missing big > >(head -c 1)`), unless it answers itself (`tee -p`).
        await _send_stderr(sink, io)
        if not await answer_closed(io, sink.emit):
            raise
        exec_node.exit_code = io.exit_code
    if io.output is not None:
        exec_node.exit_code = io.exit_code
    await _send_stderr(sink, io)
    return None, io, exec_node


async def _send_stderr(sink: JobConsole, io: IOResult) -> None:
    """Write a statement's stderr to its sink, emptying it in the result.

    Args:
        sink (JobConsole): where the statement writes.
        io (IOResult): its result.
    """
    stderr = await io.materialize_stderr()
    if stderr:
        await sink.emit(Channel.STDERR, stderr)
        io.stderr = None


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


def one_program(left: TSNodeLike, session: SessionState) -> bool:
    """Whether a job is one program (``program_word``).

    Args:
        left (TSNodeLike): the job's command.
        session (SessionState): the session the job is forked from.
    """
    return program_word(left, session) is not None


def program_word(left: TSNodeLike, session: SessionState) -> str | None:
    """The word naming the program a job is, None when it is not one, as
    bash runs ``cmd &`` as the program
    itself: a simple command whose word names neither a function nor a
    shell builtin a runtime cannot take (``eval``, ``source``), either of
    which keeps a shell between the job and the program, and which the
    signal ends. ``exec`` and ``command`` run the word after their
    options in place, so that word is the one judged; ``command -v``
    only looks it up. A word an expansion spells, or one still quoting a
    character (``e\\val``), is not known before it runs, and words that
    run commands of their own (``$( )``) run them as the job, so neither
    is one.

    Args:
        left (TSNodeLike): the job's command.
        session (SessionState): the session the job is forked from.
    """
    if not simple_command(left):
        return None
    invocations = command_invocations(left)
    if len(invocations) != 1:
        return None
    head, args = invocations[0]
    words = [head, *args]
    while words and words[0] in ("exec", "command"):
        wrapper, words = words[0], words[1:]
        while words and words[0] is not None and words[0].startswith("-"):
            if wrapper == "command" and set(words[0]) & {"v", "V"}:
                return None
            words = words[2:] if words[0] == "-a" else words[1:]
    head = words[0] if words else None
    if (
        head is None
        or "\\" in head
        or (head in SHELL_NAMES and head not in CAPTURABLE_BUILTINS)
        or head in session.functions
    ):
        return None
    return head


def _on_a_machine(left: TSNodeLike, context: EvaluationContext) -> bool:
    """Whether a job is one program a runtime past the workspace runs,
    which has a pid of its own there.

    Args:
        left (TSNodeLike): the job's command.
        context (EvaluationContext): the line's evaluation.
    """
    head = program_word(left, context.session)
    routing = context.frame.routing
    if head is None or routing is None:
        return False
    runtime = routing.bindings.get(head, routing.fallback)
    return getattr(runtime, "reach", "workspace") != "workspace"


def _forked(node: TSNodeLike | None, session: SessionState) -> bool:
    """Whether bash forks a statement as one program. The shell's own
    work (a builtin, a function, a compound command) is not one, and a
    subshell, a nested shell (``bash -c``) and a pipeline's stages are
    processes of their own, each a shell that runs its own programs.

    Args:
        node (TSNodeLike | None): the statement.
        session (SessionState): the shell it runs in.
    """
    if node is None or is_backgrounded(node):
        return False
    if node.type == NT.REDIRECTED_STATEMENT:
        return _forked(get_redirects(node)[0], session)
    return (
        node.type == NT.COMMAND
        and forks(node, session)
        and not nested_shell(node, session)
    )


async def tell(
    report: bytes,
    io: IOResult,
    exec_node: ExecutionNode,
    sink: JobConsole | None,
) -> None:
    """Put the report of a child a statement reaped after the statement's
    stderr: into the sink it writes to as it runs, or after the stderr it
    returns.

    Args:
        report (bytes): the report lines.
        io (IOResult): the statement's result.
        exec_node (ExecutionNode): its record.
        sink (JobConsole | None): where it writes, if anywhere.
    """
    if sink is None:
        io.stderr = await io.materialize_stderr() + report
        exec_node.stderr = (exec_node.stderr or b"") + report
        return
    await _send_stderr(sink, io)
    await sink.emit(Channel.STDERR, report)


def report_jobs(
    context: EvaluationContext, job_table: JobTable | None
) -> bytes:
    """bash's reports of the jobs its shell started that a signal ended
    since it last told, as it tells once it reaped a child or waited:
    each once, and the TERM, INT or PIPE that ended one untold. The
    signal is the one ``kill`` stopped a job with, or the one that ended
    the native program a job's status is. A substitution's shell tells
    of none.

    Args:
        context (EvaluationContext): the shell.
        job_table (JobTable | None): its jobs, None where it keeps none.
    """
    session = context.session
    if (
        job_table is None
        or session.process_id is None
        or context.frame.substitution
    ):
        return b""
    told = []
    for job in job_table.list_jobs(session_of(session)):
        process = job.process
        if (
            job.reported
            or job.state == JobState.RUNNING
            or process is None
            or process.record.parent != session.process_id
        ):
            continue
        ended = job.signal if job.signal is not None else process.ended_by
        if ended is None or ended < 1 or job.exit_code != 128 + ended:
            continue
        report = signal_report(
            shell_voice(),
            [(job.shown_pid, job.exit_code, ended, job.command)],
            False,
        )
        if report:
            job.reported = True
            told.append(report)
    return encode_text("".join(told))


def report_reaped(
    frame: ExecutionFrame,
    reaped: Sequence[tuple[ProcessHandle, int, TSNodeLike]],
) -> None:
    """Queue bash's report of a child its shell waited for that a signal
    ended (``signal_report``), empty when it prints none, to follow the
    reaping command's stderr with those of the shell's jobs.

    Args:
        frame (ExecutionFrame): the evaluation of the reaping command.
        reaped (Sequence[tuple[ProcessHandle, int, TSNodeLike]]): each
            process of the child, its status and the command it ran.
    """
    if frame.substitution:
        return
    listed = signal_reported(reaped[-1][0].ended_by)
    processes = [
        (
            process.record.pid,
            code,
            process.ended_by,
            reported_command(node) if listed else "",
        )
        for process, code, node in reaped
    ]
    frame.reports.append(
        encode_text(signal_report(shell_voice(), processes, True))
    )


def start_shell(
    processes: ProcessTable,
    session: SessionState,
    command: str,
    run: ProcessRunner,
    parent_pid: int | None,
    started: Callable[[ProcessHandle], None] | None = None,
    one_command: bool = False,
) -> ProcessHandle:
    """Start a shell the running one forks (a subshell, a pipeline stage,
    a command substitution, a nested shell): a process in its session's
    directory that ignores the signals every shell does. A fork past the
    session's process limit fails as bash's does.

    Args:
        processes (ProcessTable): where the process starts.
        session (SessionState): the forked shell's session.
        command (str): how ``ps`` shows it.
        run (ProcessRunner): the shell's run.
        parent_pid (int | None): the process that forks it.
        started (Callable[[ProcessHandle], None] | None): called with the
            process before it runs.
        one_command (bool): the shell runs one program, which runs as it
            (``one_program``).
    """
    try:
        return processes.start(
            session_id=session.session_id,
            command=command,
            cwd=PathSpec.from_str_path(session.cwd),
            run=run,
            parent=parent_pid,
            limit=session.processes.max,
            started=started,
            ignores=SHELL_IGNORED_SIGNALS,
            one_command=one_command,
        )
    except BlockingIOError as exc:
        raise ExitSignal(FORK_FAILED_STATUS, stderr=FORK_FAILED) from exc


async def run_program(
    node: TSNodeLike,
    context: EvaluationContext,
    run: Callable[
        [],
        Coroutine[Any, Any, tuple[ByteSource | None, IOResult, ExecutionNode]],
    ],
    job_table: JobTable | None = None,
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run one statement to the end of its output. A program its shell
    forks (``sleep 3``) runs where a signal the shell ignores still stops
    it, whole, as bash forks each with that signal back at its default:
    QUIT, which every shell ignores, and INT, which a background job's
    does. The statement ends with 128 plus the signal, and the shell
    goes on, telling of the jobs a signal ended as it reaped the child.
    A native program's signal (``program_signaled``) counts for the
    statement that ran it only.

    Args:
        node (TSNodeLike): the statement.
        context (EvaluationContext): the evaluation's session and frame.
        run (Callable): the statement, its output drained.
        job_table (JobTable | None): the shell's jobs, None to leave
            their reports to the node running the statement.
        sink (JobConsole | None): where the statement writes as it runs.
    """
    runner = current_caller().process
    if runner is not None:
        runner.program_signaled(None)
    shell = context.frame.shell
    if shell is None or not _forked(node, context.session):
        return await run()
    # What the child runs is its own, which the signal stops with it.
    context.frame.shell = None
    try:
        result, signal = await shell.program(run)
    finally:
        context.frame.shell = shell
    if signal is None:
        assert result is not None
        stdout, io, ran = result
    else:
        code = 128 + signal
        if node.type != NT.COMMAND:
            context.session._pipe_status_pending = (code,)
        record_status(context.session, code)
        stdout, io = None, IOResult(exit_code=code)
        ran = ExecutionNode(command=get_text(node), exit_code=code)
    if job_table is None:
        context.frame.reports.append(b"")
        return stdout, io, ran
    told = report_jobs(context, job_table)
    if told:
        await tell(told, io, ran, sink)
    return stdout, io, ran


async def handle_background(
    execute_node: Callable[
        ..., Awaitable[tuple[ByteSource | None, IOResult, ExecutionNode]]
    ],
    left: TSNodeLike,
    right: TSNodeLike | None,
    context: EvaluationContext,
    job_table: JobTable,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
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
    evaluates included (the walker binds it into their entry point), and the
    job revokes it when it ends, which spends what no other hand-off
    still holds.
    """
    session = context.session
    release_program = retain_programs([left])
    child_evaluation = child_context(context)
    bg_session = child_evaluation.session
    held_inputs = hold_inputs(bg_session.open_inputs())

    async def drop_holds() -> None:
        failure: Exception | None = None
        while held_inputs:
            try:
                await held_inputs.pop().lines.unhold()
            except Exception as exc:
                if failure is not None:
                    logger.debug("job: dropping a hold failed", exc_info=True)
                failure = failure or exc
        if failure is not None:
            raise failure

    def release_job(_: asyncio.Task[Any] | None = None) -> None:
        release_program()

    def drop_unrun_holds(task: asyncio.Task[Any]) -> None:
        if held_inputs:
            soon(task.get_loop(), drop_holds())

    inherit_traps(bg_session)
    output = session.job_output or session.tty.jobs
    # A job is a shell of its own: what jobs it starts write into the
    # statement it runs, then where it writes.
    bg_session.job_output = JobOutput(output)
    # A job is a child shell outside every loop: `{ break; } &` in a
    # loop refuses, as bash's does.
    bg_call_stack = (call_stack or CallStack()).fork(
        loops=False, paren=None if simple_command(left) else True
    )
    job_handed = (
        decisions.split(
            session.session_id, handed, occurrence_of(left, handed)
        )
        if handed is not None and decisions is not None
        else None
    )

    command = (
        get_redirects(left)[0]
        if left.type == NT.REDIRECTED_STATEMENT
        else left
    )
    # How a job takes an INT or a QUIT, which its shell ignores: one
    # program ignores it too, and a shell that runs commands of its own
    # (`{ sleep 3; echo x; } &`) loses only the program it runs right now
    # (`run_program`). A builtin or a function its shell runs (`f &`) ends
    # with that program on INT, as bash's shell does of an INT its child
    # died of.
    piped = command is not None and command.type == NT.PIPELINE
    one_command = command is not None and command.type == NT.COMMAND
    ends = one_command and not forks(command, session)
    in_place = (one_command and not ends) or (
        command is not None and command.type == NT.SUBSHELL
    )

    async def _run_bg(job: JobHandle) -> tuple[IOResult, ExecutionNode]:
        child_evaluation.frame.shell = None if in_place else job.process
        if job.process is not None:
            job.process.pipeline = piped
        # Background jobs don't receive stdin, matching real shell
        # behavior where bg processes get /dev/null. This prevents
        # race conditions when stdin is an async iterator.
        # What the job writes stays in its console and goes where its
        # shell writes as it is written: the terminal, or the
        # substitution or pipe it was started in.
        console = Tee(job.console, output)
        cmd_str_inner = get_text(left) if hasattr(left, "text") else str(left)
        held = False
        ended_held = False
        outer = current_caller()
        line_sink = outer.refusals

        def note(refusal: Refusal) -> None:
            # The line still hears of every refusal; a question left
            # waiting also holds the job.
            nonlocal held
            held = held or is_pending(refusal)
            if line_sink is not None:
                line_sink(refusal)

        # The job's own layer of the caller. The task's context snapshot
        # still points at the OUTER session (create_task copies the
        # context before the fork can be bound), and the fork keeps its
        # parent's id, so without it a nested eval inside the job resolves
        # the outer session and escapes the fork. The job's session writes
        # are calls of the job's, spent at its end, not of the line it
        # outlives.
        token = bind_caller(
            replace(
                outer,
                session=child_evaluation.session,
                evaluation=child_evaluation,
                call=(
                    (decisions, job_handed, session.session_id)
                    if job_handed is not None and decisions is not None
                    else outer.call
                ),
                refusals=note if line_sink is not None else None,
            )
        )

        async def run_job() -> tuple[IOResult, ExecutionNode]:
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
                    line_handle=LineHandle(
                        new_line_id(), bg_session.session_id, cmd_str_inner
                    ),
                    ends_shell=True,
                    jobs=job_table.child(),
                )
            except ExitSignal as sig:
                # A background job is its own shell: exit ends the job
                # only, a simple command the top shell forked with the
                # status that shell would exit with (`: ${U?} &` is 127,
                # `{ : ${U?}; } &` and `( : ${U?} & )` are 1).
                stdout = sig.stdout or b""
                status = (
                    sig.exit_code
                    if simple_command(left)
                    and not sig.sourced
                    and not (call_stack is not None and call_stack.subshell)
                    else sig.contained_code
                )
                io = IOResult(exit_code=status, stderr=sig.stderr or None)
                exec_node = ExecutionNode(
                    command=cmd_str_inner,
                    stderr=sig.stderr,
                    exit_code=status,
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

        async def taking_interrupts() -> tuple[IOResult, ExecutionNode]:
            if not ends or job.process is None:
                return await run_job()
            ran, signal = await job.process.program(run_job, ENDING_SIGNALS)
            if signal is None:
                assert ran is not None
                return ran
            code = 128 + signal
            return IOResult(exit_code=code), ExecutionNode(
                command=cmd_str_inner, exit_code=code
            )

        try:
            try:
                # The job runs under the `@line` limit of the line that
                # started it, from its own start, its output included: a
                # job is past it as a line is, 124 and the line's message.
                io, exec_node = await run_with_timeout(
                    taking_interrupts(),
                    child_evaluation.frame.line_timeout,
                    LINE_NAME,
                    reached=(
                        None if job.process is None else job.process.expire
                    ),
                )
            except CommandTimeoutError as exc:
                msg = encode_text(str(exc) + "\n")
                io = IOResult(exit_code=TIMEOUT_STATUS)
                exec_node = ExecutionNode(
                    command=cmd_str_inner, stderr=msg, exit_code=TIMEOUT_STATUS
                )
                # The job's own console keeps the notice; the shell's
                # output gets it unless a reader that stopped reading
                # holds it past the wait a stopped job is given, so the
                # job still ends.
                await job.console.emit(Channel.STDERR, msg)
                try:
                    async with asyncio.timeout(STOP_WAIT_SECONDS):
                        await output.emit(Channel.STDERR, msg)
                except TimeoutError:
                    logger.debug(
                        "job %d: its timeout notice found no reader", job.pid
                    )
            ended_held = held or is_pending(io.refusal)
            return io, exec_node
        finally:
            release_job()
            reset_caller(token)
            await bg_session.close_inputs()
            await drop_holds()
            if job_handed is not None and decisions is not None:
                # A job that ended held on a question leaves its grants
                # standing for the retry, as a held line does; a killed
                # or failed one spends them.
                if ended_held:
                    decisions.release(session.session_id, job_handed)
                else:
                    await decisions.revoke(session.session_id, job_handed)

    cmd_str = get_text(left) if hasattr(left, "text") else str(left)

    # Non-interactive bash announces nothing on launch ("[1] <pid>" is
    # interactive-only); the job stays discoverable via $! and `jobs`.
    try:
        job = await job_table.submit(
            command=cmd_str,
            run=_run_bg,
            cwd=bg_session.cwd,
            session_id=session.session_id,
            parent=session.process_id,
            limit=session.processes.max,
            simple=one_program(left, session),
        )
    except BaseException as exc:
        release_job()
        await drop_holds()
        # A submission that fails (a console the table cannot build, a
        # session at its process cap) or is cancelled while the job store
        # answers starts no runner, so nothing would ever revoke the
        # job's hand-off: its grants would stay reserved for good,
        # neither spent nor on offer to any later line.
        if job_handed is not None and decisions is not None:
            await decisions.revoke(session.session_id, job_handed)
        if isinstance(exc, BlockingIOError):
            raise ExitSignal(FORK_FAILED_STATUS, stderr=FORK_FAILED) from exc
        raise
    # A job killed before its runner starts never enters _run_bg, so its
    # leases and its holds on readers also go when its task ends.
    if job.process is not None:
        job.process.task.add_done_callback(release_job)
        job.process.task.add_done_callback(drop_unrun_holds)
        bg_session.process_id = job.process.record.pid
    # `$!` is the program's own pid, once it has started and has one, and
    # a pipeline's the last stage's.
    if job.process is not None and (piped or _on_a_machine(left, context)):
        await job.process.placed(RUN_START_WAIT_SECONDS)
    if (
        job.process is not None
        and job.process.stages
        and command is not None
        and _on_a_machine(get_pipeline_stages(command).commands[-1], context)
    ):
        await job.process.stages[-1].placed(RUN_START_WAIT_SECONDS)
    session.last_bg_job_id = job.last_pid
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
    execute_node: Callable[
        ..., Awaitable[tuple[ByteSource | None, IOResult, ExecutionNode]]
    ],
    node: TSNodeLike,
    context: EvaluationContext,
    stdin: ByteSource | None,
    bound: tuple[SharedInput | None, bool],
    call_stack: CallStack | None,
    job_table: JobTable | None,
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
        stdin,
        call_stack,
        handed,
        decisions,
    )
