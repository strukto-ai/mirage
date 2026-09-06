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

import tree_sitter

from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.policy import Policies, PolicyDenied
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import ERREXIT_EXEMPT_TYPES
from mirage.shell.errors import ArithError, ReadonlyError
from mirage.shell.node_kind import pipeline_transparent
from mirage.types import PathSpec, word_text
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.executor.statement import finish_statement, record_status
from mirage.workspace.session import Session
from mirage.workspace.session.state import seed_var, session_view
from mirage.workspace.types import ExecutionNode

# Safety cap on while/until iterations. Independent of stdin size:
# even with lazy stdin (Step 15), a `while read` over a stream longer
# than this cap stops here. Cap-hit emits a stderr warning so callers
# notice silent truncation. Bump if agents process larger streams.
_MAX_WHILE = 10000


def _line_buffer(stdin: ByteSource) -> AsyncLineIterator:
    """Wrap a ByteSource (bytes or chunked async iter) as a line iterator."""
    if isinstance(stdin, bytes):
        return AsyncLineIterator(async_chain(stdin))
    return AsyncLineIterator(stdin)


async def _execute_body(
    execute_node: Callable[..., Any],
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a list of body commands sequentially."""
    all_stdout: list[ByteSource | None] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)
    for cmd in body:
        try:
            stdout, io, last_exec = await execute_node(cmd, session, stdin,
                                                       call_stack)
        except BreakSignal as sig:
            # The control builtin is a statement the loop leaves through
            # rather than closes, so its own status (0) is recorded here:
            # bash leaves `${PIPESTATUS[@]}` at `0` after `break`.
            record_status(session, 0)
            if sig.stdout is not None:
                all_stdout.append(sig.stdout)
            merged_io = await merged_io.merge(sig.io)
            combined = async_chain(*[s for s in all_stdout
                                     if s is not None]) if any(
                                         s is not None
                                         for s in all_stdout) else None
            raise BreakSignal(stdout=combined, io=merged_io, levels=sig.levels)
        except ContinueSignal as sig:
            record_status(session, 0)
            if sig.stdout is not None:
                all_stdout.append(sig.stdout)
            merged_io = await merged_io.merge(sig.io)
            combined = async_chain(*[s for s in all_stdout
                                     if s is not None]) if any(
                                         s is not None
                                         for s in all_stdout) else None
            raise ContinueSignal(stdout=combined,
                                 io=merged_io,
                                 levels=sig.levels)
        stdout = await finish_statement(stdout, io, session, cmd)
        all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)
        if (io.exit_code != 0 and session.shell_options.get("errexit")
                and cmd.type not in ERREXIT_EXEMPT_TYPES
                and not session.errexit_immune):
            merged_io.exit_code = io.exit_code
            break
    non_empty = [s for s in all_stdout if s is not None]
    combined = async_chain(*non_empty) if non_empty else None
    return combined, merged_io, last_exec


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


class ReturnSignal(Exception):

    def __init__(self, exit_code: int = 0, stderr: bytes = b"") -> None:
        self.exit_code = exit_code
        self.stderr = stderr


def _chain_streams(all_stdout: list[ByteSource | None]) -> ByteSource | None:
    non_empty = [s for s in all_stdout if s is not None]
    return async_chain(*non_empty) if non_empty else None


def _collect_loop_result(
    all_stdout: list[ByteSource | None],
    merged_io: IOResult,
    label: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    exec_node = ExecutionNode(command=label, exit_code=merged_io.exit_code)
    non_empty = [s for s in all_stdout if s is not None]
    if not non_empty:
        return None, merged_io, exec_node
    return async_chain(*non_empty), merged_io, exec_node


async def handle_if(
    execute_node: Callable[..., Any],
    branches: list[tuple[tree_sitter.Node, list[tree_sitter.Node]]],
    else_body: list[tree_sitter.Node] | None,
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    for condition, body in branches:
        cond_stdout, cond_io, _ = await execute_node(condition, session, stdin,
                                                     call_stack)
        await apply_barrier(cond_stdout, cond_io, BarrierPolicy.STATUS)
        record_status(session,
                      cond_io.exit_code,
                      transparent=pipeline_transparent(condition))
        if cond_io.exit_code == 0:
            return await _execute_body(execute_node, body, session, stdin,
                                       call_stack)
    if else_body is not None:
        return await _execute_body(execute_node, else_body, session, stdin,
                                   call_stack)
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
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    view = session_view(session, policies)
    # The loop variable is the shell's own write: readonly is bash's
    # rule, checked up front so the loop never starts, exactly as bash
    # refuses `for x` on a readonly x before the first iteration.
    if view.is_readonly(variable):
        err = f"bash: {variable}: readonly variable\n".encode()
        return _collect_loop_result([], IOResult(exit_code=1, stderr=err),
                                    "for")
    saved = session.env.get(variable)

    # Save and materialize stdin for re-reading across iterations
    prev_buffer = session._stdin_buffer
    if stdin is not None:
        session._stdin_buffer = _line_buffer(stdin)
        stdin = None

    try:
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
                    IOResult(exit_code=1, stderr=f"{exc.strerror}\n".encode()))
                break
            try:
                stdout, io, _ = await _execute_body(execute_node, body,
                                                    session, stdin, call_stack)
            except BreakSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                if sig.levels > 1:
                    raise BreakSignal(stdout=_chain_streams(all_stdout),
                                      io=merged_io,
                                      levels=sig.levels - 1)
                break
            except ContinueSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                if sig.levels > 1:
                    raise ContinueSignal(stdout=_chain_streams(all_stdout),
                                         io=merged_io,
                                         levels=sig.levels - 1)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
    finally:
        session._stdin_buffer = prev_buffer
        if saved is not None:
            seed_var(session, variable, saved)
        else:
            session.vars.pop(variable, None)
    return _collect_loop_result(all_stdout, merged_io, "for")


async def _condition_loop(
    execute_node: Callable[..., Any],
    condition: tree_sitter.Node,
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    label: str,
    break_on_zero: bool,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    prev_buffer = session._stdin_buffer
    if stdin is not None:
        session._stdin_buffer = _line_buffer(stdin)
        stdin = None
    try:
        hit_limit = True
        for _ in range(_MAX_WHILE):
            if session.shell_options.get("noexec"):
                hit_limit = False
                break
            cond_stdout, cond_io, _ = await execute_node(
                condition, session, stdin, call_stack)
            await apply_barrier(cond_stdout, cond_io, BarrierPolicy.STATUS)
            record_status(session,
                          cond_io.exit_code,
                          transparent=pipeline_transparent(condition))
            if break_on_zero and cond_io.exit_code == 0:
                hit_limit = False
                break
            if (not break_on_zero and cond_io.exit_code != 0):
                hit_limit = False
                break
            try:
                stdout, io, _ = await _execute_body(execute_node, body,
                                                    session, stdin, call_stack)
            except BreakSignal as sig:
                hit_limit = False
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                if sig.levels > 1:
                    raise BreakSignal(stdout=_chain_streams(all_stdout),
                                      io=merged_io,
                                      levels=sig.levels - 1)
                break
            except ContinueSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                if sig.levels > 1:
                    raise ContinueSignal(stdout=_chain_streams(all_stdout),
                                         io=merged_io,
                                         levels=sig.levels - 1)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
        if hit_limit:
            warn = (f"warning: {label} loop terminated after "
                    f"{_MAX_WHILE} iterations\n").encode()
            existing = merged_io.stderr
            if isinstance(existing, bytes) and existing:
                merged_io.stderr = existing + warn
            else:
                merged_io.stderr = warn
    finally:
        session._stdin_buffer = prev_buffer
    return _collect_loop_result(all_stdout, merged_io, label)


async def handle_cfor(
    execute_node: Callable[..., Any],
    exprs: list[list[tree_sitter.Node]],
    body: list[tree_sitter.Node],
    eval_expr: Callable[..., Any],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run bash's C-style for: ((init; cond; update)) around a body.

    Args:
        execute_node (Callable): recursive node executor.
        exprs (list[list[tree_sitter.Node]]): init, condition and
            update expression slots, each the comma-separated
            expressions it holds; any may be empty (`for ((;;))`).
        body (list[tree_sitter.Node]): do_group statements.
        eval_expr (Callable): async evaluator taking (expr, default)
            and returning the expression's integer value, or the
            default when the slot is empty; raises ArithError with the
            offending expression text on an invalid expression, or
            ReadonlyError when it assigns to a readonly variable.
        session (Session): shell session.
        stdin (ByteSource | None): input stream, line-buffered across
            iterations like for/while.
        call_stack (CallStack | None): function-call scope, if any.
    """
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    prev_buffer = session._stdin_buffer
    if stdin is not None:
        session._stdin_buffer = _line_buffer(stdin)
        stdin = None
    try:
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
                        execute_node, body, session, stdin, call_stack)
                except BreakSignal as sig:
                    hit_limit = False
                    if sig.stdout is not None:
                        all_stdout.append(sig.stdout)
                    merged_io = await merged_io.merge(sig.io)
                    if sig.levels > 1:
                        raise BreakSignal(stdout=_chain_streams(all_stdout),
                                          io=merged_io,
                                          levels=sig.levels - 1)
                    break
                except ContinueSignal as sig:
                    if sig.stdout is not None:
                        all_stdout.append(sig.stdout)
                    merged_io = await merged_io.merge(sig.io)
                    if sig.levels > 1:
                        raise ContinueSignal(stdout=_chain_streams(all_stdout),
                                             io=merged_io,
                                             levels=sig.levels - 1)
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
                err = f"bash: {exc}\n".encode()
            elif isinstance(exc, PolicyDenied):
                err = f"bash: {exc.strerror}\n".encode()
            else:
                err = f"bash: ((: {exc}\n".encode()
            merged_io = await merged_io.merge(IOResult(exit_code=1,
                                                       stderr=err))
            merged_io.exit_code = 1
            return _collect_loop_result(all_stdout, merged_io, "for")
        if hit_limit:
            warn = (f"warning: for loop terminated after "
                    f"{_MAX_WHILE} iterations\n").encode()
            existing = merged_io.stderr
            if isinstance(existing, bytes) and existing:
                merged_io.stderr = existing + warn
            else:
                merged_io.stderr = warn
    finally:
        session._stdin_buffer = prev_buffer
    return _collect_loop_result(all_stdout, merged_io, "for")


async def handle_while(
    execute_node: Callable[..., Any],
    condition: tree_sitter.Node,
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return await _condition_loop(execute_node,
                                 condition,
                                 body,
                                 session,
                                 stdin,
                                 call_stack,
                                 "while",
                                 break_on_zero=False)


async def handle_until(
    execute_node: Callable[..., Any],
    condition: tree_sitter.Node,
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return await _condition_loop(execute_node,
                                 condition,
                                 body,
                                 session,
                                 stdin,
                                 call_stack,
                                 "until",
                                 break_on_zero=True)


async def handle_case(
    execute_node: Callable[..., Any],
    word: str,
    items: list[tuple[list[str], list[tree_sitter.Node], str]],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    all_stdout: list[ByteSource] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="case", exit_code=0)
    ran = False
    fallthrough = False
    for patterns, body, terminator in items:
        if not (fallthrough or any(fnmatch(word, p) for p in patterns)):
            continue
        ran = True
        for stmt in body:
            stdout, io, last_exec = await execute_node(stmt, session, stdin,
                                                       call_stack)
            stdin = None
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
    combined = async_chain(*all_stdout) if all_stdout else None
    return combined, merged_io, last_exec


async def handle_select(
    execute_node: Callable[..., Any],
    variable: str,
    values: list[str | PathSpec],
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    policies: Policies | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run bash's select loop: menu to stderr, choice read from stdin.

    Each iteration prompts with PS3's default ``#? ``, reads one line,
    stores it raw in REPLY, and sets the variable to the chosen value
    (empty for an out-of-range or non-numeric reply, like bash). An
    empty reply redisplays the menu without running the body; EOF ends
    the loop.

    Args:
        execute_node (Callable): recursive node executor.
        variable (str): the select variable name.
        values (list[str | PathSpec]): menu entries, already expanded.
        body (list[tree_sitter.Node]): loop body statements.
        session (Session): shell session state.
        stdin (ByteSource | None): line source for choices.
        call_stack (CallStack | None): function-call scope, if any.
    """
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    view = session_view(session, policies)
    saved = session.env.get(variable)

    prev_buffer = session._stdin_buffer
    if stdin is not None:
        session._stdin_buffer = _line_buffer(stdin)
        stdin = None

    menu = "".join(f"{i + 1}) {word_text(v)}\n"
                   for i, v in enumerate(values)).encode()
    merged_io = await merged_io.merge(IOResult(stderr=menu))
    try:
        for _ in range(_MAX_WHILE):
            if session.shell_options.get("noexec"):
                break
            merged_io = await merged_io.merge(IOResult(stderr=b"#? "))
            line_bytes = None
            if session._stdin_buffer is not None:
                line_bytes = await session._stdin_buffer.readline()
            if line_bytes is None:
                # bash terminates the prompt line with a newline when
                # the choice read hits EOF.
                all_stdout.append(b"\n")
                break
            reply = line_bytes.decode(errors="replace").rstrip("\n")
            if not reply:
                merged_io = await merged_io.merge(IOResult(stderr=menu))
                continue
            choice = ""
            if reply.strip().isdigit():
                idx = int(reply.strip())
                if 1 <= idx <= len(values):
                    choice = word_text(values[idx - 1])
            # REPLY and the select variable go through the session door
            # like the for-loop variable; readonly is the shell's own
            # rule, checked before the door is asked.
            frozen = next(
                (n for n in ("REPLY", variable) if view.is_readonly(n)), None)
            if frozen is not None:
                err = f"bash: {frozen}: readonly variable\n".encode()
                merged_io = await merged_io.merge(
                    IOResult(exit_code=1, stderr=err))
                break
            try:
                await view.set("REPLY", reply)
                await view.set(variable, choice)
            except PolicyDenied as exc:
                merged_io = await merged_io.merge(
                    IOResult(exit_code=1, stderr=f"{exc.strerror}\n".encode()))
                break
            try:
                stdout, io, _ = await _execute_body(execute_node, body,
                                                    session, None, call_stack)
            except BreakSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                if sig.levels > 1:
                    raise BreakSignal(stdout=_chain_streams(all_stdout),
                                      io=merged_io,
                                      levels=sig.levels - 1)
                break
            except ContinueSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                if sig.levels > 1:
                    raise ContinueSignal(stdout=_chain_streams(all_stdout),
                                         io=merged_io,
                                         levels=sig.levels - 1)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
    finally:
        session._stdin_buffer = prev_buffer
        if saved is not None:
            seed_var(session, variable, saved)
        else:
            session.vars.pop(variable, None)
    return _collect_loop_result(all_stdout, merged_io, "select")
