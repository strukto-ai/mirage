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

import re
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput, line_buffer
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, materialize
from mirage.policy import Policies, PolicyDenied
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.errors import (
    ArithError,
    ExitSignal,
    ReadonlyError,
    ReturnSignal,
)
from mirage.shell.job_table import JobTable
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec, word_text
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.read.read import read_reply
from mirage.workspace.executor.jobs import run_statement
from mirage.workspace.executor.statement import (
    errexit_acts,
    fd0_binding,
    finish_statement,
    ignoring_errexit,
    land,
    record_status,
)
from mirage.workspace.executor.traps import (
    err_trap_armed,
    run_err_trap,
    run_return_trap,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import session_view, visible_env
from mirage.workspace.types import ExecutionNode

_MAX_WHILE = 10000

BodyRun = Callable[
    ..., Awaitable[tuple[ByteSource | None, IOResult, ExecutionNode]]
]


async def execute_body(
    execute_node: Callable[..., Any],
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable | None,
    agent_id: str | None,
    handed: HandOff | None,
    decisions: Decisions | None,
    execute_fn: Callable[..., Any] | None = None,
    sink: JobConsole | None = None,
    bound: tuple[SharedInput | None, bool] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a list of statements in order: a group, a loop or ``if``
    body, a ``case`` arm, a function body.

    A statement ending in ``&`` is launched as a job through
    ``run_statement`` rather than run inline; ``job_table`` and
    ``agent_id`` are the job plane it needs. The ERR action answers a
    failing statement, its output landed through ``sink`` when the body
    writes to one, and ``set -e`` stops the list. ``bound`` is
    ``fd0_binding`` as the construct running the list started, so an
    ``exec <&-`` in a loop body reaches the next test. A comment leaves
    ``$?`` as it was, and a ``break`` or ``continue`` records its own
    status as it leaves (bash leaves ``${PIPESTATUS[@]}`` at ``0``).
    """
    session = context.session
    all_stdout: list[ByteSource | None] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)
    if bound is None:
        bound = fd0_binding(session)
    for cmd in body:
        if cmd.type == NT.COMMENT:
            continue
        armed = err_trap_armed(session)
        try:
            stdout, io, last_exec = await run_statement(
                execute_node,
                cmd,
                context,
                stdin,
                bound,
                call_stack,
                job_table,
                agent_id,
                handed,
                decisions,
            )
            all_stdout.append(await finish_statement(stdout, io, session, cmd))
            merged_io = await merged_io.merge(io)
            merged_io = await land(
                await run_err_trap(
                    execute_fn,
                    cmd,
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
            if isinstance(sig, LoopSignal):
                record_status(session, sig.io.exit_code)
            raise await carried(sig, _chain_streams(all_stdout), merged_io)
        if errexit_acts(cmd, io.exit_code, session):
            break
    return _chain_streams(all_stdout), merged_io, last_exec


class LoopSignal(Exception):
    def __init__(self, stdout=None, io=None, levels: int = 1):
        self.stdout = stdout
        self.io = io if io is not None else IOResult()
        self.levels = levels


class BreakSignal(LoopSignal):
    pass


class ContinueSignal(LoopSignal):
    pass


def _chain_streams(all_stdout: list[ByteSource | None]) -> ByteSource | None:
    non_empty = [s for s in all_stdout if s not in (None, b"")]
    return async_chain(non_empty) if non_empty else None


UNWINDING = (LoopSignal, ReturnSignal, ExitSignal)


async def carried(
    sig: Exception, stdout: ByteSource | None, io: IOResult
) -> Exception:
    """An unwinding ``break``, ``continue``, ``return`` or ``exit`` with
    the output the construct it leaves had produced put in front of its
    own, which that construct would otherwise drop on the way out (bash
    wrote it as it went).

    Args:
        sig (Exception): one of ``UNWINDING``.
        stdout (ByteSource | None): the construct's output so far.
        io (IOResult): the construct's result so far, its stderr.
    """
    if isinstance(sig, LoopSignal):
        sig.stdout = _chain_streams([stdout, sig.stdout])
        sig.io = await io.merge(sig.io)
        return sig
    if isinstance(sig, (ReturnSignal, ExitSignal)):
        sig.stderr = (await materialize(io.stderr) or b"") + sig.stderr
        sig.stdout = (
            (await materialize(stdout) or b"") + (sig.stdout or b"")
            if isinstance(sig, ExitSignal)
            else _chain_streams([stdout, sig.stdout])
        )
    return sig


async def returning(
    execute_fn: Callable[..., Any] | None,
    session: SessionState,
    stdin: ByteSource | None,
    call_stack: CallStack,
    stdout: ByteSource | None,
    io: IOResult,
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """What a function or a sourced file gives back as it returns: its
    output and status, with what its RETURN action wrote after the
    output. A ``return`` in a function's action returns from the
    function with its status. A sourced file has returned by the time
    its action runs, so a ``return`` there leaves the function around
    it, or only complains at the top level. An ``exit``, or that
    ``return``, leaves with the output in front of its own.

    Args:
        execute_fn (Callable[..., Any] | None): runs the action.
        session (SessionState): the shell returning.
        stdin (ByteSource | None): its standard input.
        call_stack (CallStack): the returning frames.
        stdout (ByteSource | None): what it wrote.
        io (IOResult): its result.
        sink (JobConsole | None): where it writes as it goes, if
            anywhere.
    """
    frame = call_stack.current
    frame.closed = frame.sourced
    if session.function_names is not None:
        session.function_names = call_stack.function_names()
    outputs = [stdout]
    try:
        io = await land(
            await run_return_trap(execute_fn, session, stdin, call_stack),
            sink,
            outputs,
            io,
        )
    except UNWINDING as sig:
        left = await carried(sig, stdout, io)
        if not isinstance(left, ReturnSignal) or frame.sourced:
            raise left
        return left.stdout, IOResult(
            stderr=left.stderr or None, exit_code=left.exit_code
        )
    return _chain_streams(outputs), io


def ended(sig: Exception, simple: bool = False) -> IOResult:
    """What a child shell reports when one of ``UNWINDING`` ends it:
    what it wrote, its diagnostic, and its status, ``exit``'s contained
    one, ``return``'s own, or that of ``break`` or ``continue``.

    Args:
        sig (Exception): one of ``UNWINDING``.
        simple (bool): the child runs one simple command, which is the
            shell ``exit`` ends, so it reports ``exit``'s own status
            (``: ${U?} | cat`` is 127, ``( : ${U?} ) | cat`` is 1),
            unless the signal left text ``eval`` or ``source`` ran.
    """
    if isinstance(sig, LoopSignal):
        return IOResult(
            stdout=sig.stdout, stderr=sig.io.stderr, exit_code=sig.io.exit_code
        )
    assert isinstance(sig, (ExitSignal, ReturnSignal))
    return IOResult(
        stdout=sig.stdout,
        stderr=sig.stderr or None,
        exit_code=(
            sig.contained_code
            if isinstance(sig, ExitSignal) and (not simple or sig.sourced)
            else sig.exit_code
        ),
    )


async def take_stdout(sig: Exception) -> bytes:
    """Take what a nested line wrote before it left (an ``exec``'d
    command, an ERR or RETURN action), for the redirects it ran under to
    route. An EXIT action's output, the ``cleanup`` at its end, goes
    around them, and what the other unwinding signals carry went through
    them already.

    Args:
        sig (Exception): one of ``UNWINDING``.
    """
    if not isinstance(sig, (ExitSignal, ReturnSignal)) or not sig.unrouted:
        return b""
    written = await materialize(sig.stdout) or b""
    cut = len(written) - (
        len(sig.cleanup) if isinstance(sig, ExitSignal) else 0
    )
    sig.stdout = written[cut:] or None
    return written[:cut]


async def take_stderr(sig: Exception) -> bytes:
    """Take the diagnostic one of ``UNWINDING`` carries, for the
    redirects it was written under to route.

    Args:
        sig (Exception): one of ``UNWINDING``.
    """
    if isinstance(sig, LoopSignal):
        diagnostic = await materialize(sig.io.stderr) or b""
        sig.io.stderr = None
        return diagnostic
    assert isinstance(sig, (ExitSignal, ReturnSignal))
    diagnostic, sig.stderr = sig.stderr, b""
    return diagnostic


async def _absorbed(
    sig: LoopSignal,
    all_stdout: list[ByteSource | None],
    merged_io: IOResult,
) -> IOResult:
    """Fold a ``break`` or ``continue`` into the loop it reached; one
    aimed further out (``break 2``) goes on with a level spent and the
    loop's output in front of its own.

    Args:
        sig (LoopSignal): what the body raised.
        all_stdout (list[ByteSource | None]): the loop's output so far,
            extended in place.
        merged_io (IOResult): the loop's result so far.
    """
    all_stdout.append(sig.stdout)
    merged_io = await merged_io.merge(sig.io)
    if sig.levels > 1:
        sig.stdout, sig.io = _chain_streams(all_stdout), merged_io
        sig.levels -= 1
        raise sig
    return merged_io


def _collect_loop_result(
    all_stdout: list[ByteSource | None],
    merged_io: IOResult,
    label: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    exec_node = ExecutionNode(command=label, exit_code=merged_io.exit_code)
    return _chain_streams(all_stdout), merged_io, exec_node


async def handle_if(
    run: BodyRun,
    branches: list[tuple[list[TSNodeLike], list[TSNodeLike]]],
    else_body: list[TSNodeLike] | None,
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # Each test and the branch read the fd 0 the `if` started with, so an
    # `exec < f` or `exec <&-` in one reaches the next.
    bound = fd0_binding(session)
    # What the tests wrote stays, ahead of what the branch writes.
    lead_stdout: list[ByteSource | None] = []
    lead = IOResult()
    try:
        for test, body in branches:
            with ignoring_errexit(session):
                stdout, io, _ = await run(test, bound=bound)
            lead_stdout.append(stdout)
            lead = await lead.merge(io)
            if io.exit_code == 0:
                break
        else:
            body = else_body or []
        stdout, io, last_exec = await run(body, bound=bound)
    except UNWINDING as sig:
        raise await carried(sig, _chain_streams(lead_stdout), lead)
    return (
        _chain_streams([*lead_stdout, stdout]),
        await lead.merge(io),
        last_exec,
    )


# `set -n` inside a loop body has to stop the *driver* too, not only the
# statements: `execute_node` refuses every node while the option is on,
# so the `break` or the false condition the driver is waiting for is one
# of the refused nodes and it would spin to `_MAX_WHILE`. GNU never runs
# the loop at all, which is what falling straight out of it produces.
async def handle_for(
    run: BodyRun,
    variable: str,
    values: list[str | PathSpec],
    body: list[TSNodeLike],
    context: EvaluationContext,
    policies: Policies | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    session = context.session
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    view = session_view(
        session, policies, diagnostics=context.frame.diagnostics
    )
    # The loop variable is the shell's own write: readonly is bash's
    # rule, checked up front so the loop never starts, exactly as bash
    # refuses `for x` on a readonly x before the first iteration.
    if view.is_readonly(variable):
        err = encode_text(f"bash: {variable}: readonly variable\n")
        return _collect_loop_result(
            [], IOResult(exit_code=1, stderr=err), "for"
        )
    # Each iteration reads the fd 0 the loop started with, so an
    # `exec < f` in one reaches the next.
    bound = fd0_binding(session)
    for val in values:
        if session.shell_options.get("noexec"):
            break
        # bash keeps `for f in sub/*.txt` matches relative, so the loop
        # variable takes the typed form; a policy denial aborts the loop
        # before its body runs.
        try:
            await view.set(variable, word_text(val))
        except PolicyDenied as exc:
            merged_io = await merged_io.merge(
                IOResult(exit_code=1, stderr=encode_text(f"{exc.strerror}\n"))
            )
            break
        except ArithError as exc:
            raise exc.signal(fatal=True) from exc
        try:
            stdout, io, _ = await run(body, bound=bound)
        except LoopSignal as sig:
            merged_io = await _absorbed(sig, all_stdout, merged_io)
            if isinstance(sig, BreakSignal):
                break
            continue
        merged_io = await merged_io.merge(io)
        all_stdout.append(stdout)
    # The loop variable is an ordinary variable in bash and keeps its
    # last value after the loop (`for X in a b; do :; done; echo $X`
    # prints b); nothing is put back.
    return _collect_loop_result(all_stdout, merged_io, "for")


async def handle_while(
    run: BodyRun,
    test: list[TSNodeLike],
    body: list[TSNodeLike],
    session: SessionState,
    until: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    label = "until" if until else "while"
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    # Each test and body reads the fd 0 the loop started with, so an
    # `exec < f` in one reaches the rest.
    bound = fd0_binding(session)
    for _ in range(_MAX_WHILE):
        if session.shell_options.get("noexec"):
            break
        try:
            with ignoring_errexit(session):
                cond_stdout, cond_io, _ = await run(test, bound=bound)
            all_stdout.append(cond_stdout)
            merged_io = await merged_io.merge(
                IOResult(stderr=cond_io.stderr, exit_code=merged_io.exit_code)
            )
            if (cond_io.exit_code == 0) == until:
                break
            stdout, io, _ = await run(body, bound=bound)
        except LoopSignal as sig:
            merged_io = await _absorbed(sig, all_stdout, merged_io)
            if isinstance(sig, BreakSignal):
                break
            continue
        except UNWINDING as sig:
            raise await carried(sig, _chain_streams(all_stdout), merged_io)
        merged_io = await merged_io.merge(io)
        all_stdout.append(stdout)
    else:
        _capped(merged_io, label)
    return _collect_loop_result(all_stdout, merged_io, label)


def _capped(io: IOResult, label: str) -> None:
    """Say on stderr that a loop stopped at ``_MAX_WHILE`` iterations,
    mirage's own cap (bash has none), so a runaway loop or a ``while
    read`` over a longer stream is never cut short silently.

    Args:
        io (IOResult): the loop's result, its stderr extended in place.
        label (str): the loop's keyword.
    """
    warn = encode_text(
        f"warning: {label} loop terminated after {_MAX_WHILE} iterations\n"
    )
    io.stderr = io.stderr + warn if isinstance(io.stderr, bytes) else warn


async def handle_cfor(
    run: BodyRun,
    exprs: list[list[TSNodeLike]],
    body: list[TSNodeLike],
    eval_expr: Callable[..., Any],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run bash's C-style for: ((init; cond; update)) around a body.

    bash runs the update after a ``continue`` too. An expression error
    aborts the loop with status 1, keeping the output of the iterations
    that ran, or ends the shell with it in a subscript; a PolicyDenied is
    a header expression assigning a hidden name.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        exprs (list[list[TSNodeLike]]): init, condition and
            update expression slots, each the comma-separated
            expressions it holds; any may be empty (`for ((;;))`).
        body (list[TSNodeLike]): do_group statements.
        eval_expr (Callable): async evaluator taking (expr, default)
            and returning the expression's integer value, or the
            default when the slot is empty; raises ArithError with the
            offending expression text on an invalid expression, or
            ReadonlyError when it assigns to a readonly variable.
        session (SessionState): the shell running the loop.
    """
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    bound = fd0_binding(session)
    try:
        await eval_expr(exprs[0], 0)
        for _ in range(_MAX_WHILE):
            if session.shell_options.get("noexec"):
                break
            if await eval_expr(exprs[1], 1) == 0:
                break
            try:
                stdout, io, _ = await run(body, bound=bound)
            except LoopSignal as sig:
                merged_io = await _absorbed(sig, all_stdout, merged_io)
                if isinstance(sig, BreakSignal):
                    break
                await eval_expr(exprs[2], 0)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
            await eval_expr(exprs[2], 0)
        else:
            _capped(merged_io, "for")
    except (ArithError, PolicyDenied, ReadonlyError) as exc:
        if isinstance(exc, ArithError) and exc.in_subscript:
            stdout = _chain_streams(all_stdout)
            raise await carried(exc.signal(), stdout, merged_io) from exc
        voice = "((: " if isinstance(exc, ArithError) else ""
        said = exc.strerror if isinstance(exc, PolicyDenied) else exc
        merged_io = await merged_io.merge(
            IOResult(exit_code=1, stderr=encode_text(f"bash: {voice}{said}\n"))
        )
        merged_io.exit_code = 1
    return _collect_loop_result(all_stdout, merged_io, "for")


async def handle_case(
    run: BodyRun,
    word: str,
    items: list[tuple[list[str], list[TSNodeLike], str]],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the first arm whose pattern matches ``word``, and after it
    the arms its terminator reaches: ``;&`` falls into the next arm's
    body untested, ``;;&`` tests the rest, ``;;`` stops.
    """
    all_stdout: list[ByteSource | None] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="case", exit_code=0)
    fallthrough = False
    # Each arm reads the fd 0 the `case` started with, so an `exec < f`
    # in one reaches an arm it falls into.
    bound = fd0_binding(session)
    for patterns, body, terminator in items:
        if not (fallthrough or any(fnmatch(word, p) for p in patterns)):
            continue
        try:
            stdout, io, last_exec = await run(body, bound=bound)
        except UNWINDING as sig:
            raise await carried(sig, _chain_streams(all_stdout), merged_io)
        all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)
        fallthrough = terminator == ";&"
        if session.errexit_exiting or terminator not in (";&", ";;&"):
            break
    return _chain_streams(all_stdout), merged_io, last_exec


def _select_menu(words: list[str], columns: str) -> str:
    """The select menu as bash 5.2 prints it: column-major in
    ``$COLUMNS`` (80 when unset or not positive), each cell padded with
    tabs to an 8-wide stop, one entry per row when they all fit on one.

    Args:
        words (list[str]): the menu entries.
        columns (str): ``$COLUMNS`` as set.
    """
    width = (
        int(match.group())
        if (match := re.match(r"\s*[+-]?\d+", columns))
        else 0
    )
    index_len = len(str(len(words)))
    cell = max(map(len, words)) + index_len + 4
    rows = -(-len(words) // max((width if width > 0 else 80) // cell, 1))
    if rows == 1:
        rows = len(words)
    lines: list[str] = []
    for row in range(rows):
        line = ""
        for pos, ind in enumerate(range(row, len(words), rows)):
            while len(line.expandtabs()) < pos * cell:
                line += (
                    "\t"
                    if (pos * cell) // 8 > len(line.expandtabs()) // 8
                    else " "
                )
            label = len(str(rows)) if pos == 0 else index_len
            line += f"{ind + 1:>{label}}) {words[ind]}"
        lines.append(line + "\n")
    return "".join(lines)


async def handle_select(
    run: BodyRun,
    variable: str,
    values: list[str | PathSpec],
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    policies: Policies | None = None,
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run bash's select loop: menu to stderr, choice read from stdin.

    Each iteration prompts with ``$PS3`` (``#? `` when unset), takes a
    line the way a bare ``read`` does into REPLY, and sets the variable
    to the chosen entry (empty for an out-of-range or non-numeric reply,
    like bash). An empty reply redisplays the menu without running the
    body, and so does a body that empties REPLY; end of input prints a
    newline and ends the loop with status 1. An empty list runs nothing.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        variable (str): the select variable name.
        values (list[str | PathSpec]): menu entries, already expanded.
        body (list[TSNodeLike]): loop body statements.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): line source for choices.
        policies (Policies | None): the session view's policies.
        sink (JobConsole | None): where the body's statements write as
            they finish, so the loop's own newline lands in order.
    """
    session = context.session
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    view = session_view(
        session, policies, diagnostics=context.frame.diagnostics
    )
    lines = line_buffer(stdin) if stdin is not None else None
    bound = fd0_binding(session)
    words = [word_text(v) for v in values]
    show_menu = bool(words)
    for _ in range(_MAX_WHILE if words else 0):
        if session.shell_options.get("noexec"):
            break
        env = visible_env(session)
        menu = _select_menu(words, env.get("COLUMNS", "")) if show_menu else ""
        merged_io = await merged_io.merge(
            IOResult(stderr=encode_text(menu + env.get("PS3", "#? ")) or None)
        )
        reply = await read_reply(lines) if lines is not None else None
        # A failed choice read (end of input, a readonly REPLY) ends the
        # prompt line; a readonly loop variable fails after it.
        frozen = None
        if reply is not None and view.is_readonly("REPLY"):
            frozen = "REPLY"
        elif reply and view.is_readonly(variable):
            frozen = variable
        if reply is None or frozen == "REPLY":
            if sink is not None:
                await sink.emit(Channel.STDOUT, b"\n")
            else:
                all_stdout.append(b"\n")
        if reply is None or frozen is not None:
            err = f"bash: {frozen}: readonly variable\n" if frozen else ""
            merged_io = await merged_io.merge(
                IOResult(exit_code=1, stderr=encode_text(err) or None)
            )
            break
        number = re.fullmatch(r"\s*([+-]?\d+)[ \t]*", reply)
        index = int(number.group(1)) if number else 0
        try:
            await view.set("REPLY", reply)
            show_menu = not reply
            if show_menu:
                continue
            await view.set(
                variable, words[index - 1] if 1 <= index <= len(words) else ""
            )
        except PolicyDenied as exc:
            merged_io = await merged_io.merge(
                IOResult(exit_code=1, stderr=encode_text(f"{exc.strerror}\n"))
            )
            break
        except ArithError as exc:
            raise exc.signal(fatal=True) from exc
        try:
            stdout, io, _ = await run(body, bound=bound)
        except LoopSignal as sig:
            merged_io = await _absorbed(sig, all_stdout, merged_io)
            if isinstance(sig, BreakSignal):
                break
        else:
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
        show_menu = not visible_env(session).get("REPLY")
    # As with `for`, the selection variable keeps its last value.
    return _collect_loop_result(all_stdout, merged_io, "select")
