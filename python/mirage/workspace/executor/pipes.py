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
from typing import Any

from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.io import IOResult
from mirage.io.stream import (async_chain, close_quietly, discard_io,
                              discard_streams)
from mirage.io.types import ByteSource, materialize
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.runtime.types import DispatchFn
from mirage.shell.call_stack import CallStack
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.console.types import Channel
from mirage.shell.constants import ERREXIT_EXEMPT_TYPES
from mirage.shell.descriptors import unreadable_stdin
from mirage.shell.errors import ExitSignal, PipeClosed
from mirage.shell.job_table import JobTable
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.workspace.executor.builtins.exec import (divert_statement,
                                                     stdout_to_stderr)
from mirage.workspace.executor.jobs import handle_background, pump
from mirage.workspace.executor.statement import (carry_status,
                                                 finish_statement,
                                                 record_status)
from mirage.workspace.session import (SessionState, reset_current_session,
                                      set_current_session)
from mirage.workspace.types import ExecutionNode


async def handle_pipe(
    execute_node,
    commands: list[TSNodeLike],
    stderr_flags: list[bool],
    session: SessionState,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Connect commands via pipes: stdout -> stdin."""
    pipes = [
        PipeConsole(i < len(stderr_flags) and stderr_flags[i])
        for i in range(len(commands))
    ]
    ios: list[IOResult] = [IOResult() for _ in commands]
    child_nodes: list[ExecutionNode] = [ExecutionNode() for _ in commands]

    async def run_segment(i: int, cmd: TSNodeLike) -> None:
        child = session.fork()
        child.terminal_output = session.terminal_output and i == len(
            commands) - 1
        token = set_current_session(child)
        output = pipes[i]
        input_stream = stdin if i == 0 else pipes[i - 1].stream()
        io = IOResult()
        child_exec = ExecutionNode()
        try:
            stdout, io, child_exec = await execute_node(
                cmd,
                child,
                input_stream,
                call_stack.fork() if call_stack is not None else None,
                sink=output)
            await pump(output, Channel.STDOUT, stdout)
            await pump(output, Channel.STDERR, io.stderr)
        except PipeClosed:
            io.exit_code = 141
        except ExitSignal as sig:
            io.exit_code = sig.contained_code
            await pump(output, Channel.STDOUT, sig.stdout)
            await pump(output, Channel.STDERR, sig.stderr)
        except BaseException as error:
            output.end(error)
            raise
        finally:
            if i > 0:
                pipes[i - 1].close_reader()
            if input_stream is not None and not isinstance(
                    input_stream, bytes):
                await close_quietly(input_stream)
            output.end()
            io.stderr = await output.snapshot(Channel.STDERR)
            ios[i] = io
            child_nodes[i] = child_exec
            reset_current_session(token)

    tasks = [
        asyncio.create_task(run_segment(i, cmd))
        for i, cmd in enumerate(commands)
    ]
    failed = False
    try:
        result = await run_with_timeout(
            asyncio.gather(materialize(pipes[-1].stream()), *tasks),
            session.pipeline_timeout_seconds, "pipeline")
        last_stdout = result[0]
    except BaseException:
        failed = True
        raise
    finally:
        for pipe in pipes:
            pipe.close_reader()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if failed:
            for io in ios:
                await discard_io(io)
            await discard_streams(stdin)

    last_io = ios[-1]
    # Parked for the boundary that closes this statement to claim as
    # `${PIPESTATUS[@]}`: the raw per-segment statuses, before pipefail
    # rewrites the pipeline's own.
    session._pipe_status_pending = tuple(io.exit_code for io in ios)
    if session.shell_options.get("pipefail"):
        rightmost_failure = next(
            (io.exit_code for io in reversed(ios) if io.exit_code != 0), 0)
        if rightmost_failure != 0:
            last_io.exit_code = rightmost_failure
    merged_stderr_parts: list[bytes] = []
    merged_reads: dict[str, ByteSource] = {}
    merged_writes: dict[str, ByteSource] = {}
    merged_cache: list[str] = []
    for io, child in zip(ios, child_nodes):
        child.exit_code = io.exit_code
        stderr_bytes = await materialize(io.stderr)
        if stderr_bytes:
            merged_stderr_parts.append(stderr_bytes)
        merged_reads.update(io.reads)
        merged_writes.update(io.writes)
        merged_cache.extend(io.cache)

    if merged_stderr_parts:
        last_io.stderr = b"".join(merged_stderr_parts)
    last_io.reads = merged_reads
    last_io.writes = merged_writes
    last_io.cache = merged_cache

    exec_node = ExecutionNode(op="|",
                              exit_code=last_io.exit_code,
                              children=child_nodes)
    return last_stdout, last_io, exec_node


async def _merge_left_into_exit(
    sig: ExitSignal,
    left_bytes: ByteSource | None,
    left_io: IOResult,
) -> ExitSignal:
    """Fold the left side's completed output into a propagating exit."""
    left_stderr = await materialize(left_io.stderr) or b""
    left = await materialize(left_bytes) or b""
    sig.stdout = left + (sig.stdout or b"")
    sig.stderr = left_stderr + sig.stderr
    return sig


async def handle_connection(
    execute_node,
    left: TSNodeLike,
    op: str,
    right: TSNodeLike,
    session: SessionState,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle &&, ||"""
    left_stdout, left_io, left_exec = await execute_node(
        left, session, stdin, call_stack)
    children = [left_exec]

    if op == NT.AND:
        left_bytes = await finish_statement(left_stdout, left_io, session,
                                            left)
        if left_io.exit_code != 0:
            # The failing command is left of the final `&&`, which bash
            # exempts from `set -e`. The list ran only its left side, so
            # the list boundary reports that pipeline.
            session.errexit_immune = True
            carry_status(session)
            return left_bytes, left_io, ExecutionNode(
                op="&&", exit_code=left_io.exit_code, children=children)
        try:
            right_stdout, right_io, right_exec = (await execute_node(
                right, session, stdin, call_stack))
        except ExitSignal as sig:
            raise await _merge_left_into_exit(sig, left_bytes, left_io)
        children.append(right_exec)
        right_bytes = await materialize(right_stdout)
        merged = await left_io.merge(right_io)
        combined = async_chain(left_bytes, right_bytes)
        return combined, merged, ExecutionNode(op="&&",
                                               exit_code=merged.exit_code,
                                               children=children)

    if op == NT.OR:
        left_bytes = await finish_statement(left_stdout, left_io, session,
                                            left)
        if left_io.exit_code == 0:
            carry_status(session)
            return left_bytes, left_io, ExecutionNode(
                op="||", exit_code=left_io.exit_code, children=children)
        try:
            right_stdout, right_io, right_exec = (await execute_node(
                right, session, stdin, call_stack))
        except ExitSignal as sig:
            raise await _merge_left_into_exit(sig, left_bytes, left_io)
        children.append(right_exec)
        right_bytes = await materialize(right_stdout)
        merged = await left_io.merge(right_io)
        combined = async_chain(left_bytes, right_bytes)
        return combined, merged, ExecutionNode(op="||",
                                               exit_code=merged.exit_code,
                                               children=children)

    # semicolon or other
    left_bytes = await finish_statement(left_stdout, left_io, session, left)
    try:
        right_stdout, right_io, right_exec = await execute_node(
            right, session, stdin, call_stack)
    except ExitSignal as sig:
        raise await _merge_left_into_exit(sig, left_bytes, left_io)
    children.append(right_exec)
    # Materialize right side to match && and || behavior, ensuring
    # lazy exit codes (e.g. from exit_on_empty) are finalized before
    # the combined stream is returned to the caller.
    right_bytes = await materialize(right_stdout)
    merged = await left_io.merge(right_io)
    combined = async_chain(left_bytes, right_bytes)
    return combined, merged, ExecutionNode(op=str(op),
                                           exit_code=merged.exit_code,
                                           children=children)


async def handle_subshell(
    execute_node,
    body: list[TSNodeLike],
    session: SessionState,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    dispatch: DispatchFn | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute body in isolated env.

    Args:
        execute_node (Callable): recursion bound to the subshell's own
            job table, so `wait`/`kill`/`jobs` inside see its jobs.
        body (list[TSNodeLike]): ALL subshell children, including
            the `&` tokens that mark background statements (named-only
            lists would run `a & b` synchronously and never set `$!`).
        session (SessionState): shell session; env/options snapshot-restored.
        stdin (ByteSource | None): input stream.
        call_stack (CallStack | None): function-call scope, if any.
        job_table (JobTable | None): the subshell's private job table
            (bash forks: the parent's table never sees these jobs).
        agent_id (str | None): agent identity for job bookkeeping.
        dispatch (DispatchFn | None): the op door, so a subshell honors
            an `exec` redirect the way the program loop does. A subshell
            is a child shell, so the redirect it installs is restored
            with the rest of the snapshot when the body ends.
    """
    saved = session.snapshot()
    try:
        all_stdout: list[Any] = []
        merged_io = IOResult()
        last_exec = ExecutionNode(command="()", exit_code=0)
        i = 0
        while i < len(body):
            child = body[i]
            if not child.is_named or child.type == NT.COMMENT:
                i += 1
                continue

            # `set -n` needs no arm here: `execute_node` refuses every
            # node while the option is on, so this loop simply runs a
            # tail of no-ops. The restore at the end of the subshell is
            # what keeps the option from leaking to the parent.
            is_bg = (i + 1 < len(body) and body[i + 1].type == NT.BACKGROUND)
            if is_bg and job_table is not None:
                stdout, io, last_exec = await handle_background(
                    execute_node, child, None, session, job_table, agent_id
                    or "", stdin, call_stack, handed, decisions)
                merged_io = await merged_io.merge(io)
                # Seed $? for later body commands (mirrors program loop).
                record_status(session, io.exit_code)
                if stdout is not None:
                    all_stdout.append(stdout)
                i += 2
                continue
            i += 1
            child_stdin = stdin
            if child_stdin is None and session.exec_stdin_unreadable:
                child_stdin = unreadable_stdin()
            elif child_stdin is None and session.exec_stdin is not None:
                child_stdin = session.exec_stdin
            try:
                stdout, io, last_exec = await execute_node(
                    child, session, child_stdin, call_stack)
            except ExitSignal as sig:
                # A subshell is its own shell: exit (or ${var:?}) ends
                # the subshell only, becoming its exit status.
                if sig.stdout:
                    all_stdout.append(sig.stdout)
                sig_io = IOResult(exit_code=sig.contained_code,
                                  stderr=sig.stderr or None)
                merged_io = await merged_io.merge(sig_io)
                merged_io.exit_code = sig.contained_code
                record_status(session, sig.contained_code)
                last_exec = ExecutionNode(command="()",
                                          exit_code=sig.contained_code,
                                          stderr=sig.stderr)
                break
            stdout = await finish_statement(stdout, io, session, child,
                                            last_exec)
            if dispatch is not None and (session.exec_stdout is not None
                                         or session.exec_stderr is not None):
                materialized = await materialize(stdout)
                before_divert = io.exit_code
                stdout = await divert_statement(dispatch, session,
                                                materialized, io,
                                                last_exec.command or "",
                                                stdout_to_stderr(child))
                if io.exit_code != before_divert:
                    record_status(session, io.exit_code)
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
            if (io.exit_code != 0 and session.shell_options.get("errexit")
                    and child.type not in ERREXIT_EXEMPT_TYPES
                    and not session.errexit_immune):
                merged_io.exit_code = io.exit_code
                break
        if len(all_stdout) == 1:
            return all_stdout[0], merged_io, last_exec
        combined = async_chain(*all_stdout) if all_stdout else None
        return combined, merged_io, last_exec
    finally:
        session.restore(saved)
