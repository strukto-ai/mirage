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
from mirage.shell.descriptors import ENCLOSING, Recorder, StreamOwner
from mirage.shell.errors import DiscardSignal, ExitSignal
from mirage.shell.helpers import get_text
from mirage.shell.node_kind import pipeline_transparent
from mirage.shell.types import NodeType as NT
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.exec import divert_statement
from mirage.workspace.executor.control import (
    UNWINDING,
    BreakSignal,
    ContinueSignal,
    carried,
)
from mirage.workspace.executor.jobs import handle_background
from mirage.workspace.executor.statement import (
    errexit_acts,
    failed_read,
    fd0_binding,
    land,
    record_status,
    statement_output,
    statement_stdin,
)
from mirage.workspace.executor.traps import (
    err_trap_armed,
    run_err_trap,
    run_exit_trap,
)
from mirage.workspace.types import ExecutionNode


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

    ``dispatch`` is the op door, threaded so an active ``exec`` redirect
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
    error that discards one, unless it runs in a child shell.
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
    # Source lines and the highest one `set -v` has already echoed.
    source_lines = get_text(node).split("\n")
    echoed_row = -1
    bound = fd0_binding(session)

    i = 0
    while i < len(children):
        child = children[i]

        if (
            not child.is_named
            or child.type == NT.ERROR
            or child.type == NT.COMMENT
        ):
            if child.type == NT.SEMI:
                i += 1
                continue
            i += 1
            continue

        # `set -n` reads without executing, so every statement after the
        # one that set it is skipped. Checking here rather than deeper
        # gives bash's one-way trip for free: a later `set +n` is itself
        # a statement, so it never runs and cannot turn execution back
        # on within the same input.
        if session.shell_options.get("noexec"):
            break

        # `set -v` echoes input to stderr as the reader consumes it, and
        # the unit is a *line*, not a statement: GNU answers
        # `set -v; echo a` with nothing at all, because that whole line
        # was already read before the option took effect, while
        # `set -v\necho a` echoes the second line. So a line is echoed
        # once, when the first statement on it runs, and a statement
        # spanning several lines carries all of them.
        if child.start_point[0] > echoed_row:
            # From the line after the last one echoed, not from this
            # statement's own row: the reader consumes comments and
            # blank lines too, so `# note`, an empty line and `echo ok`
            # all reach stderr. Clamping to the next executable row
            # dropped everything that carried no node.
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
            # Marked read either way: a line reaches the reader once, so
            # a line whose own first statement turned the option on was
            # already past it and is never echoed.
            echoed_row = last

        # Check for background: named node followed by & token
        is_bg = i + 1 < len(children) and children[i + 1].type == NT.BACKGROUND
        armed = err_trap_armed(session)

        if is_bg:
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
            i += 2
        else:
            # `exec < file` feeds the shell's stdin: a later `read` or
            # `while read` sees it, and each statement reads on from
            # where the one before it stopped.
            child_stdin = statement_stdin(session, stdin, bound)
            # Each statement writes to a recorder rather than straight
            # to the program's output, so what it wrote to the terminal
            # through a copy (`exec 3>&1`) keeps its place, past an
            # `exec` diversion, and what it wrote to an enclosing level's
            # stream goes on there.
            recorder = Recorder()
            enclosing = ENCLOSING.set(recorder)
            # A job this shell started writes into the statement while it
            # runs, among what the statement writes.
            jobs = session.job_output or session.tty.jobs
            held = jobs.recorder
            try:
                jobs.recorder = recorder
                try:
                    stdout, io, last_exec = await recurse(
                        child, context, child_stdin, call_stack, sink=recorder
                    )
                finally:
                    jobs.recorder = held
            except UNWINDING as sig:
                merged_io = await land(
                    await statement_output(
                        recorder, None, IOResult(), own, sink
                    ),
                    sink,
                    all_stdout,
                    merged_io,
                )
                if (
                    isinstance(sig, DiscardSignal)
                    and not (call_stack is not None and call_stack.subshell)
                    and not session.shell_options.get("errexit")
                ):
                    # bash's DISCARD: the rest of this line goes, and the
                    # loop resumes at the next line with `$?` at 1.
                    merged_io = await land(
                        [
                            (channel, data, False)
                            for channel, data in (
                                (Channel.STDOUT, sig.stdout or b""),
                                (Channel.STDERR, sig.stderr),
                            )
                            if data
                        ],
                        sink,
                        all_stdout,
                        merged_io,
                    )
                    merged_io.exit_code = sig.exit_code
                    record_status(session, sig.exit_code)
                    last_exec = ExecutionNode(
                        command=get_text(child),
                        exit_code=sig.exit_code,
                        stderr=sig.stderr,
                    )
                    i = _next_line(node, children, i)
                    continue
                if inline:
                    raise await carried(
                        sig,
                        async_chain(all_stdout) if all_stdout else None,
                        merged_io,
                    )
                # Anything else ends this shell: `exit`, or an error bash
                # treats as one, keeping what earlier statements wrote.
                if sig.stdout:
                    all_stdout.append(sig.stdout)
                if isinstance(sig, (BreakSignal, ContinueSignal)):
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
                last_exec = ExecutionNode(
                    command="exit", exit_code=merged_io.exit_code
                )
                break
            finally:
                ENCLOSING.reset(enclosing)
            # Materialize stdout so lazy exit codes (e.g. from
            # exit_on_empty in grep) are finalized before $? is set.
            try:
                stdout = await materialize(stdout)
            except OSError as exc:
                # Lazy reads (head/tail opening the stream mid-pipeline) can
                # fail on the first pull, which is the command's failure.
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
            i += 1
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
            stdout = None
            merged_io = await land(written, sink, all_stdout, merged_io)
        if stdout is not None:
            all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)

        if not is_bg:
            trapped = await run_err_trap(
                execute_fn,
                child,
                io.exit_code,
                session,
                armed,
                stdin,
                call_stack,
            )
            if trapped:
                merged_io = await land(trapped, sink, all_stdout, merged_io)
                merged_io.exit_code = io.exit_code
        if not is_bg and errexit_acts(child, io.exit_code, session):
            merged_io.exit_code = io.exit_code
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
    """The first statement after ``children[i]`` on a later line, where
    a discarded line resumes. The parse has joined continued lines and
    folded each heredoc body into its statement, so a newline between
    two statements is a line break.

    Args:
        node (Any): the program.
        children (list[Any]): its children.
        i (int): the statement that discarded its line.
    """
    text = node.text or b""
    base = node.start_byte
    end = children[i].end_byte
    j = i + 1
    while (
        j < len(children)
        and b"\n" not in text[end - base : children[j].start_byte - base]
    ):
        end = children[j].end_byte
        j += 1
    return j
