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

from mirage._rs import Shell, ShellNode, ShellTask
from mirage.commands.builtin.utils.strtol import atoi
from mirage.execution.job import JobTable
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput, line_buffer
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, materialize
from mirage.policy import PolicyDenied
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.descriptors import Recorder
from mirage.shell.errors import (
    ArithError,
    ExitSignal,
    ReturnSignal,
)
from mirage.shell.parse.program import shell_node
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.shell.voice import shell_voice
from mirage.shell.xtrace import trace_line
from mirage.types import PathSpec, word_text
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.background import run_program, run_statement
from mirage.workspace.executor.builtins.read.read import read_reply
from mirage.workspace.executor.statement import (
    errexit_acts,
    fd0_binding,
    finish_statement,
    ignoring_errexit,
    land,
    record_status,
    write_error_line,
)
from mirage.workspace.executor.traps import (
    err_trap_armed,
    run_err_trap,
    run_return_trap,
)
from mirage.workspace.expand.node import ExpandHost
from mirage.workspace.node.diagnostics import diagnostic_stderr
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import frame, session_view, visible_env
from mirage.workspace.session.task import drive
from mirage.workspace.types import ExecutionNode

BodyRun = Callable[
    ..., Awaitable[tuple[ByteSource | None, IOResult, ExecutionNode]]
]


async def execute_body(
    execute_node: BodyRun,
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable | None,
    handed: HandOff | None,
    decisions: Decisions | None,
    execute_fn: Callable[..., Any] | None = None,
    sink: JobConsole | None = None,
    bound: tuple[SharedInput | None, bool] | None = None,
    leading: bytes = b"",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a list of statements in order: a group, a loop or ``if``
    body, a ``case`` arm, a function body.

    A statement ending in ``&`` is launched as a job through
    ``run_statement`` rather than run inline; ``job_table`` is the
    job plane it needs. The ERR action answers a
    failing statement, its output landed through ``sink`` when the body
    writes to one, and ``set -e`` stops the list. ``bound`` is
    ``fd0_binding`` as the construct running the list started, so an
    ``exec <&-`` in a loop body reaches the next test. A comment leaves
    ``$?`` as it was, and a ``break`` or ``continue`` records its own
    status as it leaves (bash leaves ``${PIPESTATUS[@]}`` at ``0``).
    ``leading`` is stderr that goes out before the first statement.
    """
    session = context.session
    all_stdout: list[ByteSource | None] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)
    if bound is None:
        bound = fd0_binding(session)
    if leading:
        merged_io = await land(
            [(Channel.STDERR, leading, False)], sink, all_stdout, merged_io
        )
    for cmd in body:
        if cmd.type == NT.COMMENT:
            continue
        armed = err_trap_armed(session)

        async def statement() -> tuple[
            ByteSource | None, IOResult, ExecutionNode
        ]:
            stdout, io, ran = await run_statement(
                execute_node,
                cmd,
                context,
                stdin,
                bound,
                call_stack,
                job_table,
                handed,
                decisions,
            )
            return await finish_statement(stdout, io, session, cmd), io, ran

        try:
            stdout, io, last_exec = await run_program(
                cmd, context, statement, job_table, sink
            )
            if isinstance(sink, Recorder) and sink.refused:
                # A write an `exec` in the body sent where no write goes
                # (`exec 1<f`) fails the statement that made it.
                sink.refused = False
                await sink.emit(
                    Channel.STDERR, write_error_line(last_exec.command or "")
                )
                io.exit_code = 1
                record_status(session, 1)
            all_stdout.append(stdout)
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
    def __init__(
        self,
        stdout: ByteSource | None = None,
        io: IOResult | None = None,
        levels: int = 1,
    ) -> None:
        self.stdout = stdout
        self.io = io if io is not None else IOResult()
        self.levels = levels


class BreakSignal(LoopSignal):
    pass


class ContinueSignal(LoopSignal):
    pass


def _keep(
    all_stdout: list[ByteSource | None], stdout: ByteSource | None
) -> None:
    """Add what one turn of a loop wrote to the loop's output, nothing for
    a turn that wrote nothing, so a loop with no end holds no more for it.

    Args:
        all_stdout (list[ByteSource | None]): the loop's output so far.
        stdout (ByteSource | None): what the turn wrote.
    """
    if stdout not in (None, b""):
        all_stdout.append(stdout)


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
        sig.stderr = (await materialize(io.stderr)) + sig.stderr
        sig.stdout = (
            (await materialize(stdout)) + (sig.stdout or b"")
            if isinstance(sig, ExitSignal)
            else _chain_streams([stdout, sig.stdout])
        )
    return sig


async def trailed(sig: Exception, stdout: bytes, stderr: bytes) -> None:
    """Put what an unwinding construct's process substitutions wrote as
    they finished behind the output the signal already carries.

    Args:
        sig (Exception): one of ``UNWINDING``.
        stdout (bytes): output to follow the signal's own.
        stderr (bytes): diagnostics to follow the signal's own.
    """
    if not stdout and not stderr:
        return
    if isinstance(sig, LoopSignal):
        sig.stdout = _chain_streams([sig.stdout, stdout])
        if stderr:
            sig.io.stderr = (await materialize(sig.io.stderr)) + stderr
    elif isinstance(sig, ExitSignal):
        sig.stdout = (sig.stdout or b"") + stdout
        sig.stderr += stderr
    elif isinstance(sig, ReturnSignal):
        sig.stdout = _chain_streams([sig.stdout, stdout])
        sig.stderr += stderr


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
    session.call_lines = call_stack.call_lines()
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
    written = await materialize(sig.stdout)
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
        diagnostic = await materialize(sig.io.stderr)
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
    _keep(all_stdout, sig.stdout)
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


class _ConstructHost(ExpandHost):
    """What a compound command asks of the shell: to run the lists of
    statements it picks, here, keeping what they wrote.

    Args:
        body (BodyRun): ``execute_body`` bound to the walk.
        lists (list[list[TSNodeLike]]): the construct's lists.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
        word (TSNodeLike | None): a word of the construct, whose program
            the nodes it names belong to.
        whole_tests (bool): a test's whole result joins the construct's
            rather than its stderr alone.
    """

    def __init__(
        self,
        body: BodyRun,
        lists: list[list[TSNodeLike]],
        context: EvaluationContext,
        execute_fn: Callable[..., Any],
        call_stack: CallStack | None,
        word: TSNodeLike | None,
        whole_tests: bool,
    ) -> None:
        super().__init__(context, execute_fn, call_stack, word)
        self.body = body
        self.lists = lists
        self.whole_tests = whole_tests
        self.all_stdout: list[ByteSource | None] = []
        self.merged_io = IOResult()
        self.last_exec: ExecutionNode | None = None
        self.loop_signal: LoopSignal | None = None
        self.left: Exception | None = None
        # Each test and body reads the fd 0 the construct started with,
        # so an `exec < f` in one reaches the rest.
        self.bound = fd0_binding(context.session)

    def leading(self, traced: str) -> bytes:
        """What goes out before the next list: what the construct's own
        words said, then what ``set -x`` printed since the last list.

        Args:
            traced (str): the lines the shell traced.
        """
        said = diagnostic_stderr(None, self.context)
        self.context.frame.diagnostics.clear()
        return said + encode_text(traced)

    async def run(
        self,
        index: int,
        test: bool,
        start: int,
        pending: int | None,
        framed: bool,
        traced: str,
    ) -> tuple[int, str, int, bool]:
        session = self.session
        if pending is not None:
            record_status(session, pending)
        statements = self.lists[index]
        if start:
            statements = statements[start:]
        leading = self.leading(traced)
        try:
            if test:
                with ignoring_errexit(session):
                    stdout, io, _ = await self.body(
                        statements, bound=self.bound, leading=leading
                    )
                kept = (
                    io
                    if self.whole_tests
                    else IOResult(
                        stderr=io.stderr, exit_code=self.merged_io.exit_code
                    )
                )
            else:
                stdout, io, self.last_exec = await self.body(
                    statements, bound=self.bound, leading=leading
                )
                kept = io
        except LoopSignal as sig:
            _keep(self.all_stdout, sig.stdout)
            self.merged_io = await self.merged_io.merge(sig.io)
            self.loop_signal = sig
            if framed:
                frame(session, self.call_stack)
            tag = "break" if isinstance(sig, BreakSignal) else "continue"
            return sig.io.exit_code, tag, sig.levels, False
        except UNWINDING as sig:
            self.left = sig
            return 0, "stop", 0, False
        _keep(self.all_stdout, stdout)
        self.merged_io = await self.merged_io.merge(kept)
        status = io.exit_code
        # The list changed the session; a construct that reads it reads
        # it as it goes on.
        if framed:
            frame(session, self.call_stack)
        leaving = session.errexit_exiting and not test
        return (
            status,
            "",
            0,
            leaving or bool(session.shell_options.get("noexec")),
        )


async def _run_construct(
    start: Callable[[Shell], ShellTask],
    body: BodyRun,
    lists: list[list[TSNodeLike]],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    word: TSNodeLike | None = None,
    whole_tests: bool = False,
    framed: bool = True,
) -> _ConstructHost:
    """Run a compound command on the session's shell, which picks each
    list and hands it here to run.

    Args:
        start (Callable[[Shell], ShellTask]): starts it on the shell.
        body (BodyRun): ``execute_body`` bound to the walk.
        lists (list[list[TSNodeLike]]): the construct's lists.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
        word (TSNodeLike | None): a word of the construct, for the nodes
            its expansions name.
        whole_tests (bool): a test's whole result joins the construct's.
        framed (bool): the shell reads the session as the construct goes.

    Returns:
        The host holding what the lists wrote.
    """
    session = context.session
    if framed:
        frame(session, call_stack)
    host = _ConstructHost(
        body, lists, context, execute_fn, call_stack, word, whole_tests
    )
    try:
        said, failed, tag, levels, pending, status, traced = await drive(
            start(session.vars.shell), host, context.frame.diagnostics
        )
    except UNWINDING as sig:
        raise await carried(
            sig, _chain_streams(host.all_stdout), host.merged_io
        )
    if pending is not None:
        record_status(session, pending)
    if traced:
        _, last, _ = await body(
            [], bound=host.bound, leading=host.leading(traced)
        )
        host.merged_io = await host.merged_io.merge(
            IOResult(stderr=last.stderr, exit_code=host.merged_io.exit_code)
        )
    stdout = _chain_streams(host.all_stdout)
    if host.left is not None:
        raise await carried(host.left, stdout, host.merged_io)
    if tag:
        signal = host.loop_signal
        assert signal is not None
        signal.stdout, signal.io, signal.levels = (
            stdout,
            host.merged_io,
            levels,
        )
        raise signal
    if status is not None:
        host.merged_io.exit_code = status
    if failed:
        host.merged_io = await host.merged_io.merge(
            IOResult(exit_code=1, stderr=encode_text(said) or None)
        )
    return host


def _looped(
    host: _ConstructHost, label: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """A loop's result: what its lists wrote, and its status.

    Args:
        host (_ConstructHost): the loop's host.
        label (str): the loop's name, for the node.
    """
    return _collect_loop_result(host.all_stdout, host.merged_io, label)


def _finished(
    host: _ConstructHost, label: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """An ``if``'s or a ``case``'s result: the last body's node stands
    for it, or a node of its own when no body ran.

    Args:
        host (_ConstructHost): the construct's host.
        label (str): the name a construct running no body reports.
    """
    node = host.last_exec or ExecutionNode(command=label, exit_code=0)
    return _chain_streams(host.all_stdout), host.merged_io, node


async def handle_if(
    run: BodyRun,
    branches: list[tuple[list[TSNodeLike], list[TSNodeLike]]],
    else_body: list[TSNodeLike] | None,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``if``: each test in turn, then the branch the first passing
    one opens, or the ``else``.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        branches (list): each branch's test and body.
        else_body (list[TSNodeLike] | None): the ``else`` body.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
    """
    lists = [else_body or []]
    pairs: list[tuple[int, int]] = []
    for test, body in branches:
        pairs.append((len(lists), len(lists) + 1))
        lists.extend((test, body))
    host = await _run_construct(
        lambda shell: shell.run_if(pairs, 0),
        run,
        lists,
        context,
        execute_fn,
        call_stack,
        whole_tests=True,
        framed=False,
    )
    return _finished(host, "")


async def handle_for(
    run: BodyRun,
    variable: str,
    values: list[str | PathSpec],
    head: str,
    body: list[TSNodeLike],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``for``: bash keeps ``for f in sub/*.txt`` matches relative,
    so the variable takes each word as typed, and keeps the last.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        variable (str): the loop variable.
        values (list[str | PathSpec]): its words, already expanded.
        head (str): its first line as ``set -x`` prints it.
        body (list[TSNodeLike]): the loop's statements.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
    """
    words = [word_text(value) for value in values]
    host = await _run_construct(
        lambda shell: shell.run_for(
            variable, words, head, 0, _statements(context.session, [body])
        ),
        run,
        [body],
        context,
        execute_fn,
        call_stack,
    )
    return _looped(host, "for")


async def handle_while(
    run: BodyRun,
    test: list[TSNodeLike],
    body: list[TSNodeLike],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    until: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``while`` or ``until``.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        test (list[TSNodeLike]): the condition's statements.
        body (list[TSNodeLike]): the loop's statements.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
        until (bool): stop when the condition holds.
    """
    host = await _run_construct(
        lambda shell: shell.run_while(
            0, 1, until, _statements(context.session, [test, body])
        ),
        run,
        [test, body],
        context,
        execute_fn,
        call_stack,
    )
    return _looped(host, "until" if until else "while")


def _nodes(parts: list[TSNodeLike]) -> list[ShellNode]:
    """The parsed nodes of a construct's words.

    Args:
        parts (list[TSNodeLike]): the words.
    """
    return [node for node in map(shell_node, parts) if node is not None]


def _statements(
    session: SessionState, lists: list[list[TSNodeLike]]
) -> list[list[tuple[ShellNode, int]] | None]:
    """Each list's statements as the shell reads them, each with its
    line, None for a list holding a node it did not parse.

    Args:
        session (SessionState): the session, which numbers the lines.
        lists (list[list[TSNodeLike]]): the construct's lists.
    """
    parsed: list[list[tuple[ShellNode, int]] | None] = []
    for statements in lists:
        nodes = _nodes(statements)
        parsed.append(
            [
                (node, session.line_of(statement))
                for node, statement in zip(nodes, statements)
            ]
            if len(nodes) == len(statements)
            else None
        )
    return parsed


def _slot(exprs: list[TSNodeLike]) -> tuple[list[ShellNode], Any] | None:
    """A C-style ``for`` expression as the shell reads it: its nodes and
    the node whose start ends its text, None for an empty slot.

    Args:
        exprs (list[TSNodeLike]): the slot's nodes and tokens, in order.
    """
    if not exprs:
        return None
    closer = exprs[-1].next_sibling if exprs[0].parent is not None else None
    return _nodes(exprs), None if closer is None else shell_node(closer)


async def handle_cfor(
    run: BodyRun,
    exprs: list[list[TSNodeLike]],
    body: list[TSNodeLike],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run bash's C-style for: ((init; cond; update)) around a body.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        exprs (list[list[TSNodeLike]]): init, condition and update, each
            the nodes it holds; any may be empty (``for ((;;))``).
        body (list[TSNodeLike]): the loop's statements.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
    """
    slots = [_slot(expr) for expr in exprs]
    word = next((expr[0] for expr in exprs if expr), None)
    host = await _run_construct(
        lambda shell: shell.run_cfor(
            slots, 0, _statements(context.session, [body])
        ),
        run,
        [body],
        context,
        execute_fn,
        call_stack,
        word=word,
    )
    return _looped(host, "for")


async def handle_case(
    run: BodyRun,
    word: str,
    items: list[tuple[list[TSNodeLike], list[TSNodeLike], str]],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the first arm whose pattern matches ``word``, and after it
    the arms its terminator reaches: ``;&`` falls into the next arm's
    body untested, ``;;&`` tests the rest, ``;;`` stops.

    Args:
        run (BodyRun): ``execute_body`` bound to the walk.
        word (str): the expanded word.
        items (list): each arm's patterns, body and terminator.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable[..., Any]): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
    """
    lists = [body for _, body, _ in items]
    arms = [
        (_nodes(patterns), index, terminator)
        for index, (patterns, _, terminator) in enumerate(items)
    ]
    first = next((patterns[0] for patterns, _, _ in items if patterns), None)
    host = await _run_construct(
        lambda shell: shell.run_case(word, arms),
        run,
        lists,
        context,
        execute_fn,
        call_stack,
        word=first,
    )
    return _finished(host, "case")


def _select_menu(words: list[str], columns: str) -> str:
    """The select menu as bash 5.2 prints it: column-major in
    ``$COLUMNS`` (80 when unset or not positive), each cell padded with
    tabs to an 8-wide stop, one entry per row when they all fit on one.

    Args:
        words (list[str]): the menu entries.
        columns (str): ``$COLUMNS`` as set.
    """
    width = atoi(columns)
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
    head: str,
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
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
        head (str): its first line as ``set -x`` prints it.
        body (list[TSNodeLike]): loop body statements.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): line source for choices.
        sink (JobConsole | None): where the body's statements write as
            they finish, so the loop's own newline lands in order.
    """
    session = context.session
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    view = session_view(session, diagnostics=context.frame.diagnostics)
    lines = line_buffer(stdin) if stdin is not None else None
    bound = fd0_binding(session)
    words = [word_text(v) for v in values]
    show_menu = bool(words)
    if session.shell_options.get("xtrace"):
        merged_io = await land(
            [(Channel.STDERR, trace_line(head), False)],
            sink,
            all_stdout,
            merged_io,
        )
    while words and not session.shell_options.get("noexec"):
        env = visible_env(session)
        menu = _select_menu(words, env.get("COLUMNS", "")) if show_menu else ""
        merged_io = await land(
            [
                (
                    Channel.STDERR,
                    encode_text(menu + env.get("PS3", "#? ")),
                    False,
                )
            ],
            sink,
            all_stdout,
            merged_io,
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
            err = (
                f"{shell_voice()}{frozen}: readonly variable\n"
                if frozen
                else ""
            )
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
            _keep(all_stdout, stdout)
            if session.errexit_exiting:
                break
        show_menu = not visible_env(session).get("REPLY")
    # As with `for`, the selection variable keeps its last value.
    return _collect_loop_result(all_stdout, merged_io, "select")
