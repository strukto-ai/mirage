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
from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.async_line_iterator import line_buffer
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, materialize
from mirage.policy import Policies, PolicyDenied
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import ERREXIT_EXEMPT_TYPES
from mirage.shell.errors import (
    ArithError,
    ExitSignal,
    ReadonlyError,
    ReturnSignal,
)
from mirage.shell.job_table import JobTable
from mirage.shell.node_kind import pipeline_transparent
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec, word_text
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.read.read import read_reply
from mirage.workspace.executor.jobs import run_statement
from mirage.workspace.executor.statement import (
    fd0_binding,
    finish_statement,
    record_status,
)
from mirage.workspace.session.state import session_view, visible_env
from mirage.workspace.types import ExecutionNode

# Safety cap on while/until iterations. Independent of stdin size:
# even with lazy stdin (Step 15), a `while read` over a stream longer
# than this cap stops here. Cap-hit emits a stderr warning so callers
# notice silent truncation. Bump if agents process larger streams.
_MAX_WHILE = 10000


async def _execute_body(
    execute_node: Callable[..., Any],
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable | None,
    agent_id: str | None,
    handed: HandOff | None,
    decisions: Decisions | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a list of body commands sequentially.

    A statement ending in ``&`` is launched as a job through
    ``run_statement`` rather than run inline; ``job_table`` and
    ``agent_id`` are the job plane it needs.
    """
    session = context.session
    all_stdout: list[ByteSource | None] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)
    bound = fd0_binding(session)
    for cmd in body:
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
        except UNWINDING as sig:
            # The control builtin is a statement the loop leaves through
            # rather than closes, so its own status is recorded here:
            # bash leaves `${PIPESTATUS[@]}` at `0` after `break`.
            if isinstance(sig, (BreakSignal, ContinueSignal)):
                record_status(session, sig.io.exit_code)
            raise await carried(sig, _chain_streams(all_stdout), merged_io)
        stdout = await finish_statement(stdout, io, session, cmd)
        all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)
        if (
            io.exit_code != 0
            and session.shell_options.get("errexit")
            and cmd.type not in ERREXIT_EXEMPT_TYPES
            and not session.errexit_immune
        ):
            merged_io.exit_code = io.exit_code
            break
    return _chain_streams(all_stdout), merged_io, last_exec


class BreakSignal(Exception):
    def __init__(self, stdout=None, io=None, levels: int = 1):
        self.stdout = stdout
        self.io = io if io is not None else IOResult()
        self.levels = levels


class ContinueSignal(Exception):
    def __init__(self, stdout=None, io=None, levels: int = 1):
        self.stdout = stdout
        self.io = io if io is not None else IOResult()
        self.levels = levels


def _chain_streams(all_stdout: list[ByteSource | None]) -> ByteSource | None:
    non_empty = [s for s in all_stdout if s is not None]
    return async_chain(non_empty) if non_empty else None


UNWINDING = (BreakSignal, ContinueSignal, ReturnSignal, ExitSignal)


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
    if isinstance(sig, (BreakSignal, ContinueSignal)):
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


def ended(sig: Exception) -> IOResult:
    """What a child shell reports when one of ``UNWINDING`` ends it:
    what it wrote, its diagnostic, and its status, ``exit``'s contained
    one, ``return``'s own, or that of ``break`` or ``continue``.

    Args:
        sig (Exception): one of ``UNWINDING``.
    """
    if isinstance(sig, (BreakSignal, ContinueSignal)):
        return IOResult(
            stdout=sig.stdout, stderr=sig.io.stderr, exit_code=sig.io.exit_code
        )
    assert isinstance(sig, (ExitSignal, ReturnSignal))
    return IOResult(
        stdout=sig.stdout,
        stderr=sig.stderr or None,
        exit_code=(
            sig.contained_code
            if isinstance(sig, ExitSignal)
            else sig.exit_code
        ),
    )


async def take_stderr(sig: Exception) -> bytes:
    """Take the diagnostic one of ``UNWINDING`` carries, for the
    redirects it was written under to route.

    Args:
        sig (Exception): one of ``UNWINDING``.
    """
    if isinstance(sig, (BreakSignal, ContinueSignal)):
        diagnostic = await materialize(sig.io.stderr) or b""
        sig.io.stderr = None
        return diagnostic
    assert isinstance(sig, (ExitSignal, ReturnSignal))
    diagnostic, sig.stderr = sig.stderr, b""
    return diagnostic


async def _absorbed(
    sig: BreakSignal | ContinueSignal,
    all_stdout: list[ByteSource | None],
    merged_io: IOResult,
) -> IOResult:
    """Fold a ``break`` or ``continue`` into the loop it reached; one
    aimed further out (``break 2``) goes on with a level spent and the
    loop's output in front of its own.

    Args:
        sig (BreakSignal | ContinueSignal): what the body raised.
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
    execute_node: Callable[..., Any],
    branches: list[tuple[TSNodeLike, list[TSNodeLike]]],
    else_body: list[TSNodeLike] | None,
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    session = context.session
    bound = fd0_binding(session)
    for condition, body in branches:
        cond_stdout, cond_io, _ = await run_statement(
            execute_node,
            condition,
            context,
            stdin,
            bound,
            call_stack,
            job_table,
            agent_id,
            handed,
            decisions,
        )
        await apply_barrier(cond_stdout, cond_io, BarrierPolicy.STATUS)
        record_status(
            session,
            cond_io.exit_code,
            transparent=pipeline_transparent(condition),
        )
        if cond_io.exit_code == 0:
            return await _execute_body(
                execute_node,
                body,
                context,
                stdin,
                call_stack,
                job_table,
                agent_id,
                handed,
                decisions,
            )
    if else_body is not None:
        return await _execute_body(
            execute_node,
            else_body,
            context,
            stdin,
            call_stack,
            job_table,
            agent_id,
            handed,
            decisions,
        )
    return None, IOResult(), ExecutionNode(exit_code=0)


# `set -n` inside a loop body has to stop the *driver* too, not only the
# statements: `execute_node` refuses every node while the option is on,
# so the `break` or the false condition the driver is waiting for is one
# of the refused nodes and it would spin to `_MAX_WHILE`. GNU never runs
# the loop at all, which is what falling straight out of it produces.
async def handle_for(
    execute_node: Callable[..., Any],
    variable: str,
    values: list[str | PathSpec],
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
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

    for val in values:
        if session.shell_options.get("noexec"):
            break
        # env stores strings only; bash keeps `for f in sub/*.txt`
        # matches relative, so the loop variable takes the typed form.
        # The write goes through the session door; a policy denial
        # aborts the loop before its body runs.
        text_val = word_text(val)
        try:
            await view.set(variable, text_val)
        except PolicyDenied as exc:
            merged_io = await merged_io.merge(
                IOResult(exit_code=1, stderr=encode_text(f"{exc.strerror}\n"))
            )
            break
        try:
            stdout, io, _ = await _execute_body(
                execute_node,
                body,
                context,
                stdin,
                call_stack,
                job_table,
                agent_id,
                handed,
                decisions,
            )
        except (BreakSignal, ContinueSignal) as sig:
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


async def _condition_loop(
    execute_node: Callable[..., Any],
    condition: TSNodeLike,
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    label: str,
    break_on_zero: bool,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    session = context.session
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    hit_limit = True
    bound = fd0_binding(session)
    for _ in range(_MAX_WHILE):
        if session.shell_options.get("noexec"):
            hit_limit = False
            break
        cond_stdout, cond_io, _ = await run_statement(
            execute_node,
            condition,
            context,
            stdin,
            bound,
            call_stack,
            job_table,
            agent_id,
            handed,
            decisions,
        )
        await apply_barrier(cond_stdout, cond_io, BarrierPolicy.STATUS)
        record_status(
            session,
            cond_io.exit_code,
            transparent=pipeline_transparent(condition),
        )
        if break_on_zero and cond_io.exit_code == 0:
            hit_limit = False
            break
        if not break_on_zero and cond_io.exit_code != 0:
            hit_limit = False
            break
        try:
            stdout, io, _ = await _execute_body(
                execute_node,
                body,
                context,
                stdin,
                call_stack,
                job_table,
                agent_id,
                handed,
                decisions,
            )
        except (BreakSignal, ContinueSignal) as sig:
            merged_io = await _absorbed(sig, all_stdout, merged_io)
            if isinstance(sig, BreakSignal):
                hit_limit = False
                break
            continue
        merged_io = await merged_io.merge(io)
        all_stdout.append(stdout)
    if hit_limit:
        warn = encode_text(
            f"warning: {label} loop terminated after {_MAX_WHILE} iterations\n"
        )
        existing = merged_io.stderr
        if isinstance(existing, bytes) and existing:
            merged_io.stderr = existing + warn
        else:
            merged_io.stderr = warn
    return _collect_loop_result(all_stdout, merged_io, label)


async def handle_cfor(
    execute_node: Callable[..., Any],
    exprs: list[list[TSNodeLike]],
    body: list[TSNodeLike],
    eval_expr: Callable[..., Any],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run bash's C-style for: ((init; cond; update)) around a body.

    Args:
        execute_node (Callable): recursive node executor.
        exprs (list[list[TSNodeLike]]): init, condition and
            update expression slots, each the comma-separated
            expressions it holds; any may be empty (`for ((;;))`).
        body (list[TSNodeLike]): do_group statements.
        eval_expr (Callable): async evaluator taking (expr, default)
            and returning the expression's integer value, or the
            default when the slot is empty; raises ArithError with the
            offending expression text on an invalid expression, or
            ReadonlyError when it assigns to a readonly variable.
        context (EvaluationContext): shell session.
        stdin (ByteSource | None): input stream, which each iteration
            reads on from where the one before stopped, like for/while.
        call_stack (CallStack | None): function-call scope, if any.
        job_table (JobTable | None): the job plane for a body statement
            ending in ``&``.
        agent_id (str | None): agent identity for job bookkeeping.
        handed (HandOff | None): approval claims inherited by a job.
        decisions (Decisions | None): ledger that holds those claims.
    """
    session = context.session
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    hit_limit = True
    try:
        await eval_expr(exprs[0], 0)
        for _ in range(_MAX_WHILE):
            if session.shell_options.get("noexec"):
                hit_limit = False
                break
            if await eval_expr(exprs[1], 1) == 0:
                hit_limit = False
                break
            try:
                stdout, io, _ = await _execute_body(
                    execute_node,
                    body,
                    context,
                    stdin,
                    call_stack,
                    job_table,
                    agent_id,
                    handed,
                    decisions,
                )
            except (BreakSignal, ContinueSignal) as sig:
                merged_io = await _absorbed(sig, all_stdout, merged_io)
                if isinstance(sig, BreakSignal):
                    hit_limit = False
                    break
                # bash runs the update expression after `continue`.
                await eval_expr(exprs[2], 0)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
            await eval_expr(exprs[2], 0)
    except (ArithError, PolicyDenied, ReadonlyError) as exc:
        # bash: the loop aborts with status 1, keeping the output
        # of iterations that already ran. PolicyDenied is a header
        # expression assigning a hidden name, refused by the same
        # door as any denied assignment.
        if isinstance(exc, ReadonlyError):
            err = encode_text(f"bash: {exc}\n")
        elif isinstance(exc, PolicyDenied):
            err = encode_text(f"bash: {exc.strerror}\n")
        else:
            err = encode_text(f"bash: ((: {exc}\n")
        merged_io = await merged_io.merge(IOResult(exit_code=1, stderr=err))
        merged_io.exit_code = 1
        return _collect_loop_result(all_stdout, merged_io, "for")
    if hit_limit:
        warn = encode_text(
            f"warning: for loop terminated after {_MAX_WHILE} iterations\n"
        )
        existing = merged_io.stderr
        if isinstance(existing, bytes) and existing:
            merged_io.stderr = existing + warn
        else:
            merged_io.stderr = warn
    return _collect_loop_result(all_stdout, merged_io, "for")


async def handle_while(
    execute_node: Callable[..., Any],
    condition: TSNodeLike,
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return await _condition_loop(
        execute_node,
        condition,
        body,
        context,
        stdin,
        call_stack,
        "while",
        break_on_zero=False,
        job_table=job_table,
        agent_id=agent_id,
        handed=handed,
        decisions=decisions,
    )


async def handle_until(
    execute_node: Callable[..., Any],
    condition: TSNodeLike,
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return await _condition_loop(
        execute_node,
        condition,
        body,
        context,
        stdin,
        call_stack,
        "until",
        break_on_zero=True,
        job_table=job_table,
        agent_id=agent_id,
        handed=handed,
        decisions=decisions,
    )


async def handle_case(
    execute_node: Callable[..., Any],
    word: str,
    items: list[tuple[list[str], list[TSNodeLike], str]],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    session = context.session
    all_stdout: list[ByteSource] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="case", exit_code=0)
    ran = False
    fallthrough = False
    bound = fd0_binding(session)
    for patterns, body, terminator in items:
        if not (fallthrough or any(fnmatch(word, p) for p in patterns)):
            continue
        ran = True
        for stmt in body:
            try:
                stdout, io, last_exec = await run_statement(
                    execute_node,
                    stmt,
                    context,
                    stdin,
                    bound,
                    call_stack,
                    job_table,
                    agent_id,
                    handed,
                    decisions,
                )
            except UNWINDING as sig:
                raise await carried(
                    sig, _chain_streams(list(all_stdout)), merged_io
                )
            stdout = await finish_statement(stdout, io, session, stmt)
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
        if terminator == ";&":
            # Fall through: run the next arm's body without testing it.
            fallthrough = True
            continue
        # ;;& keeps testing remaining patterns; ;; stops here.
        fallthrough = False
        if terminator != ";;&":
            break
    if not ran:
        return None, IOResult(), ExecutionNode(command="case", exit_code=0)
    if len(all_stdout) == 1:
        return all_stdout[0], merged_io, last_exec
    combined = async_chain(all_stdout) if all_stdout else None
    return combined, merged_io, last_exec


def _select_menu(words: list[str], columns: str) -> str:
    """bash's select menu (print_select_list, bash 5.2): column-major in
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
    execute_node: Callable[..., Any],
    variable: str,
    values: list[str | PathSpec],
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
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
        execute_node (Callable): recursive node executor.
        variable (str): the select variable name.
        values (list[str | PathSpec]): menu entries, already expanded.
        body (list[TSNodeLike]): loop body statements.
        context (EvaluationContext): shell session state.
        stdin (ByteSource | None): line source for choices.
        call_stack (CallStack | None): function-call scope, if any.
        job_table (JobTable | None): the job plane for a body statement
            ending in ``&``.
        agent_id (str | None): agent identity for job bookkeeping.
        handed (HandOff | None): approval claims inherited by a job.
        decisions (Decisions | None): ledger that holds those claims.
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
        try:
            stdout, io, _ = await _execute_body(
                execute_node,
                body,
                context,
                stdin,
                call_stack,
                job_table,
                agent_id,
                handed,
                decisions,
            )
        except (BreakSignal, ContinueSignal) as sig:
            merged_io = await _absorbed(sig, all_stdout, merged_io)
            if isinstance(sig, BreakSignal):
                break
        else:
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
        show_menu = not visible_env(session).get("REPLY")
    # As with `for`, the selection variable keeps its last value.
    return _collect_loop_result(all_stdout, merged_io, "select")
