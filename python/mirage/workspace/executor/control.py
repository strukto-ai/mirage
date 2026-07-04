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

import fnmatch
from collections.abc import Callable

import tree_sitter

from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.types import PathSpec
from mirage.workspace.session import Session
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
    execute_node: Callable,
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
            if sig.stdout is not None:
                all_stdout.append(sig.stdout)
            merged_io = await merged_io.merge(sig.io)
            combined = async_chain(*[s for s in all_stdout
                                     if s is not None]) if any(
                                         s is not None
                                         for s in all_stdout) else None
            raise BreakSignal(stdout=combined, io=merged_io)
        except ContinueSignal as sig:
            if sig.stdout is not None:
                all_stdout.append(sig.stdout)
            merged_io = await merged_io.merge(sig.io)
            combined = async_chain(*[s for s in all_stdout
                                     if s is not None]) if any(
                                         s is not None
                                         for s in all_stdout) else None
            raise ContinueSignal(stdout=combined, io=merged_io)
        all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)
        if (io.exit_code != 0 and session.shell_options.get("errexit")
                and cmd.type not in ERREXIT_EXEMPT_TYPES):
            merged_io.exit_code = io.exit_code
            break
    non_empty = [s for s in all_stdout if s is not None]
    combined = async_chain(*non_empty) if non_empty else None
    return combined, merged_io, last_exec


class BreakSignal(Exception):

    def __init__(self, stdout=None, io=None):
        self.stdout = stdout
        self.io = io or IOResult()


class ContinueSignal(Exception):

    def __init__(self, stdout=None, io=None):
        self.stdout = stdout
        self.io = io or IOResult()


class ReturnSignal(Exception):

    def __init__(self, exit_code: int = 0) -> None:
        self.exit_code = exit_code


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
    execute_node: Callable,
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
        session.last_exit_code = cond_io.exit_code
        if cond_io.exit_code == 0:
            return await _execute_body(execute_node, body, session, stdin,
                                       call_stack)
    if else_body is not None:
        return await _execute_body(execute_node, else_body, session, stdin,
                                   call_stack)
    return None, IOResult(), ExecutionNode(exit_code=0)


async def handle_for(
    execute_node: Callable,
    variable: str,
    values: list[str | PathSpec],
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    saved = session.env.get(variable)

    # Save and materialize stdin for re-reading across iterations
    prev_buffer = session._stdin_buffer
    if stdin is not None:
        session._stdin_buffer = _line_buffer(stdin)
        stdin = None

    try:
        for val in values:
            # env stores strings only; PathSpec → .virtual
            session.env[variable] = (val.virtual
                                     if isinstance(val, PathSpec) else val)
            try:
                stdout, io, _ = await _execute_body(execute_node, body,
                                                    session, stdin, call_stack)
            except BreakSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                break
            except ContinueSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
    finally:
        session._stdin_buffer = prev_buffer
        if saved is not None:
            session.env[variable] = saved
        else:
            session.env.pop(variable, None)
    return _collect_loop_result(all_stdout, merged_io, "for")


async def _condition_loop(
    execute_node: Callable,
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
            cond_stdout, cond_io, _ = await execute_node(
                condition, session, stdin, call_stack)
            await apply_barrier(cond_stdout, cond_io, BarrierPolicy.STATUS)
            session.last_exit_code = cond_io.exit_code
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
                break
            except ContinueSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
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


async def handle_while(
    execute_node: Callable,
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
    execute_node: Callable,
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
    execute_node: Callable,
    word: str,
    items: list[tuple[list[str], list[tree_sitter.Node]]],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    for patterns, body in items:
        if any(fnmatch.fnmatch(word, p.strip()) for p in patterns):
            all_stdout: list[ByteSource] = []
            merged_io = IOResult()
            last_exec = ExecutionNode(command="case", exit_code=0)
            for stmt in body:
                stdout, io, last_exec = await execute_node(
                    stmt, session, stdin, call_stack)
                stdin = None
                if stdout is not None:
                    all_stdout.append(stdout)
                merged_io = await merged_io.merge(io)
            if len(all_stdout) == 1:
                return all_stdout[0], merged_io, last_exec
            combined = async_chain(*all_stdout) if all_stdout else None
            return combined, merged_io, last_exec
    return None, IOResult(), ExecutionNode(command="case", exit_code=0)


async def handle_select(
    execute_node: Callable,
    variable: str,
    values: list[str | PathSpec],
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    merged_io = IOResult()
    all_stdout: list[ByteSource | None] = []
    saved = session.env.get(variable)

    # Save and materialize stdin for re-reading across iterations
    prev_buffer = session._stdin_buffer
    if stdin is not None:
        session._stdin_buffer = _line_buffer(stdin)
        stdin = None

    try:
        for val in values:
            # env stores strings only; PathSpec → .virtual
            session.env[variable] = (val.virtual
                                     if isinstance(val, PathSpec) else val)
            try:
                stdout, io, _ = await _execute_body(execute_node, body,
                                                    session, stdin, call_stack)
            except BreakSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                break
            except ContinueSignal as sig:
                if sig.stdout is not None:
                    all_stdout.append(sig.stdout)
                merged_io = await merged_io.merge(sig.io)
                continue
            merged_io = await merged_io.merge(io)
            all_stdout.append(stdout)
    finally:
        session._stdin_buffer = prev_buffer
        if saved is not None:
            session.env[variable] = saved
        else:
            session.env.pop(variable, None)
    return _collect_loop_result(all_stdout, merged_io, "select")
