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

from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize
from mirage.io.types import ByteSource
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.descriptors import Recorder, StreamOwner
from mirage.shell.errors import DiscardSignal, ExitSignal, ReturnSignal
from mirage.shell.helpers import get_text, same_line
from mirage.shell.node_kind import pipeline_transparent
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.exec import divert_statement
from mirage.workspace.executor.control import (
    UNWINDING,
    LoopSignal,
    carried,
)
from mirage.workspace.executor.jobs import handle_background
from mirage.workspace.executor.statement import (
    as_written,
    errexit_acts,
    failed_read,
    fd0_binding,
    land,
    record_status,
    recording,
    statement_output,
    statement_stdin,
)
from mirage.workspace.executor.traps import (
    err_trap_armed,
    run_err_trap,
    run_exit_trap,
)
from mirage.workspace.session.session import SessionState
from mirage.workspace.types import ExecutionNode


class StatementRecorder(Recorder):
    """Forward ordinary output while retaining chunks needing descriptor routing."""

    def __init__(self, session: SessionState, sink: JobConsole | None) -> None:
        super().__init__()
        self._session = session
        self._sink = sink

    async def emit(self, channel: Channel, data: bytes) -> None:
        if (
            self._sink is not None
            and not self.chunks
            and self._session.exec_stdout is None
            and self._session.exec_stderr is None
        ):
            await self._sink.emit(channel, data)
        else:
            await super().emit(channel, data)


async def execute_program(
    recurse,
    node,
    context: EvaluationContext,
    stdin,
    call_stack,
    job_table,
    agent_id,
    dispatch=None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
    sink: JobConsole | None = None,
    inline: bool = False,
    execute_fn: Callable[..., Any] | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute program node (root / semicolon-separated).

    ``dispatch`` is the dispatcher, threaded so an active ``exec`` redirect
    can send each statement's output to its file; None (a nested loop
    that is not the program root) leaves output undiverted. ``handed``
    and ``decisions`` are the line's hand-off and its ledger, for a
    background job to borrow. ``sink`` takes each statement's output as
    it finishes, in the order it was written, instead of the result.
    The outermost program of a session's line routes what a statement
    wrote to the session's terminal through a copy (``exec 3>&1``); a
    nested one (``eval``, ``source``) leaves that to it. An ``inline``
    program runs on its caller's frames (``eval``, ``source``, an alias,
    ``$( )``), so an ``exit``, ``return``, ``break`` or ``continue`` goes
    on into the caller, after what the program wrote; any other program
    is a shell of its own and ends there, running its EXIT action
    through ``execute_fn``. Either resumes at its next line after an
    error that discards one, unless it runs in a child shell. ``set -n``
    stops the loop at the next statement, so a later ``set +n`` never
    runs. ``set -v`` echoes each input line once, as the first statement
    on it runs, from the line after the last one echoed, comments and
    blank lines included, so ``set -v; echo a`` echoes nothing.
    """
    session = context.session
    # Every program loop is one parse, which is the unit bash's alias
    # rule counts in: an alias defined on this parse and row is not
    # expanded by a use on the same parse and row. Restored on the way
    # out so a nested parse (`eval`, `source`, `bash -c`) does not leave
    # its id on the enclosing one.
    session._parse_seq += 1
    outer_parse = (session._parse_current, session._parse_row)
    session._parse_current = session._parse_seq
    session._parse_row = 0
    root = not session._line_open
    session._line_open = True
    try:
        return await _run_program(
            recurse,
            node,
            context,
            stdin,
            call_stack,
            job_table,
            agent_id,
            dispatch,
            handed,
            decisions,
            sink,
            session.terminal if root else None,
            inline,
            execute_fn,
        )
    finally:
        session._parse_current, session._parse_row = outer_parse
        if root:
            session._line_open = False
            session.errexit_exiting = False


async def _run_program(
    recurse,
    node,
    context: EvaluationContext,
    stdin,
    call_stack,
    job_table,
    agent_id,
    dispatch=None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
    sink: JobConsole | None = None,
    own: StreamOwner | None = None,
    inline: bool = False,
    execute_fn: Callable[..., Any] | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    session = context.session
    children = node.children
    all_stdout: list[Any] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)
    source_lines = get_text(node).split("\n")
    echoed_row = -1
    bound = fd0_binding(session)

    i = 0
    while i < len(children):
        child = children[i]

        if not child.is_named or child.type in (NT.ERROR, NT.COMMENT):
            i += 1
            continue
        if session.shell_options.get("noexec"):
            break
        if child.start_point[0] > echoed_row:
            first = echoed_row + 1
            last = child.end_point[0]
            if session.shell_options.get("verbose") and last >= first:
                text = "\n".join(source_lines[first : last + 1])
                merged_io = await land(
                    [(Channel.STDERR, encode_text(text) + b"\n", False)],
                    sink,
                    all_stdout,
                    merged_io,
                )
            echoed_row = last

        if i + 1 < len(children) and children[i + 1].type == NT.BACKGROUND:
            try:
                stdout, io, last_exec = await handle_background(
                    recurse,
                    child,
                    None,
                    context,
                    job_table,
                    agent_id,
                    stdin,
                    call_stack,
                    handed,
                    decisions,
                )
            except ExitSignal as sig:
                # A job the shell cannot fork ends the line, as a failed
                # fork(2) ends bash's.
                merged_io = await merged_io.merge(
                    IOResult(
                        exit_code=sig.exit_code, stderr=sig.stderr or None
                    )
                )
                merged_io.exit_code = sig.exit_code
                record_status(session, sig.exit_code)
                last_exec = ExecutionNode(
                    command=get_text(child),
                    exit_code=sig.exit_code,
                    stderr=sig.stderr,
                )
                break
            # Launching a job is itself a statement: bash sets $? to 0
            # (the launch status), so `false; cmd & echo $?` prints 0.
            record_status(session, io.exit_code)
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
            i += 2
            continue

        at = i
        i += 1
        armed = err_trap_armed(session)
        # Ordinary output progresses while the statement runs. Descriptor
        # copies and exec diversions retain their order for routing below.
        recorder = StatementRecorder(session, sink)
        try:
            with recording(session, recorder):
                # `exec < file` feeds the shell's stdin: a later `read` or
                # `while read` sees it, and each statement reads on from
                # where the one before it stopped.
                stdout, io, last_exec = await recurse(
                    child,
                    context,
                    statement_stdin(session, stdin, bound),
                    call_stack,
                    sink=recorder,
                )
            try:
                stdout = await materialize(stdout)
            except OSError as exc:
                # Lazy reads (head/tail opening the stream mid-pipeline)
                # can fail on the first pull, which is the command's
                # failure.
                await failed_read(io, exc, last_exec)
                stdout = None
            except Exception as exc:
                existing = await materialize(io.stderr) or b""
                io.stderr = existing + encode_text(f"{exc}\n")
                io.exit_code = 1
                stdout = None
            record_status(
                session, io.exit_code, transparent=pipeline_transparent(child)
            )
            # An `exec` redirect sends the shell's own output to a file:
            # every statement after the `exec` diverts here, so nothing
            # bubbles to the terminal and stderr lands in its own target.
            written = await divert_statement(
                dispatch,
                session,
                await statement_output(recorder, stdout, io, own, sink),
                io,
                child,
                last_exec.command or "",
            )
            merged_io = await land(written, sink, all_stdout, merged_io)
            merged_io = await merged_io.merge(io)
            merged_io = await land(
                await run_err_trap(
                    execute_fn,
                    child,
                    io.exit_code,
                    session,
                    armed,
                    stdin,
                    call_stack,
                    last_exec,
                ),
                sink,
                all_stdout,
                merged_io,
            )
        except UNWINDING as sig:
            # What it wrote before it left; the ERR action answering it
            # left after that was landed.
            merged_io = await land(
                await statement_output(recorder, None, IOResult(), own, sink),
                sink,
                all_stdout,
                merged_io,
            )
            resumes, merged_io, last_exec = await _unwound(
                sig,
                child,
                context,
                stdin,
                call_stack,
                sink,
                inline,
                execute_fn,
                all_stdout,
                merged_io,
            )
            if resumes:
                i = _next_line(node, children, at)
                continue
            break
        if errexit_acts(child, io.exit_code, session):
            if not inline:
                merged_io = await _exit_shell(
                    execute_fn,
                    context,
                    io.exit_code,
                    stdin,
                    call_stack,
                    all_stdout,
                    merged_io,
                )
            break

    if len(all_stdout) == 1:
        return all_stdout[0], merged_io, last_exec
    combined = async_chain(all_stdout) if all_stdout else None
    return combined, merged_io, last_exec


async def _unwound(
    sig: LoopSignal | ReturnSignal | ExitSignal,
    child: TSNodeLike,
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    sink: JobConsole | None,
    inline: bool,
    execute_fn: Callable[..., Any] | None,
    all_stdout: list[Any],
    merged_io: IOResult,
) -> tuple[bool, IOResult, ExecutionNode]:
    """Settle a signal that unwound out of a statement, or out of the ERR
    action that answered it.

    bash's DISCARD resumes the loop at the next line with ``$?`` at 1. An
    inline program carries anything else on into its caller, after what
    it wrote; any other program ends its shell there: ``exit``, or an
    error bash treats as one.

    Args:
        sig (LoopSignal | ReturnSignal | ExitSignal): one of ``UNWINDING``.
        child (TSNodeLike): the statement it left.
        context (EvaluationContext): the shell.
        stdin (ByteSource | None): its standard input.
        call_stack (CallStack | None): its frames.
        sink (JobConsole | None): where its output goes as it is written.
        inline (bool): the program runs on its caller's frames.
        execute_fn (Callable[..., Any] | None): runs the EXIT action.
        all_stdout (list[Any]): what the program wrote so far.
        merged_io (IOResult): its result so far.

    Returns:
        tuple[bool, IOResult, ExecutionNode]: whether the loop resumes,
        the result, and the statement's node.
    """
    session = context.session
    if (
        isinstance(sig, DiscardSignal)
        and not (call_stack is not None and call_stack.subshell)
        and not session.shell_options.get("errexit")
    ):
        merged_io = await land(
            as_written(sig.stdout, sig.stderr),
            sink,
            all_stdout,
            merged_io,
        )
        merged_io.exit_code = sig.exit_code
        record_status(session, sig.exit_code)
        return (
            True,
            merged_io,
            ExecutionNode(
                command=get_text(child),
                exit_code=sig.exit_code,
                stderr=sig.stderr,
            ),
        )
    if isinstance(sig, DiscardSignal):
        # A line loop a child shell runs ends it on a discard with the
        # discard's own status: `( eval ': ${R:=x}' )` and
        # `$( : ${R:=x} )` end with 1, where the `( )` around a bare
        # `: ${R:=x}` ends with 2.
        sig.contained_code = sig.exit_code
    if inline:
        raise await carried(
            sig,
            async_chain(all_stdout) if all_stdout else None,
            merged_io,
        )
    if sig.stdout:
        all_stdout.append(sig.stdout)
    if isinstance(sig, LoopSignal):
        code, stderr = sig.io.exit_code, sig.io.stderr
    else:
        code, stderr = sig.exit_code, sig.stderr
    merged_io = await merged_io.merge(
        IOResult(exit_code=code, stderr=stderr or None)
    )
    merged_io = await _exit_shell(
        execute_fn,
        context,
        code,
        stdin,
        call_stack,
        all_stdout,
        merged_io,
    )
    record_status(session, merged_io.exit_code)
    return (
        False,
        merged_io,
        ExecutionNode(command="exit", exit_code=merged_io.exit_code),
    )


async def _exit_shell(
    execute_fn: Callable[..., Any] | None,
    context: EvaluationContext,
    code: int,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    all_stdout: list[Any],
    merged_io: IOResult,
) -> IOResult:
    """End this shell with ``code``, running its EXIT action after what
    it wrote, and return its result with the status the shell ends with.

    Args:
        execute_fn (Callable[..., Any] | None): runs the action.
        context (EvaluationContext): the shell.
        code (int): the status it ends with.
        stdin (ByteSource | None): its standard input.
        call_stack (CallStack | None): its frames.
        all_stdout (list[Any]): its output so far, extended in place.
        merged_io (IOResult): its result so far.
    """
    session = context.session
    cleanup = await run_exit_trap(execute_fn, session, code, stdin, call_stack)
    if cleanup is None:
        merged_io.exit_code = code
        return merged_io
    all_stdout.append(cleanup.stdout)
    merged_io = await merged_io.merge(IOResult(stderr=cleanup.stderr))
    merged_io.exit_code = cleanup.exit_code
    return merged_io


def _next_line(node: Any, children: list[Any], i: int) -> int:
    """The first statement after ``children[i]`` on a later line
    (``same_line``), where a discarded line resumes.

    Args:
        node (Any): the program.
        children (list[Any]): its children.
        i (int): the statement that discarded its line.
    """
    j = i + 1
    while j < len(children) and same_line(node, children[j - 1], children[j]):
        j += 1
    return j
