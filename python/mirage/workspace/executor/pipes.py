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

from typing import Any

import tree_sitter

from mirage.commands.builtin.utils.safeguard import run_with_timeout
from mirage.io import IOResult
from mirage.io.stream import async_chain, close_quietly, merge_stdout_stderr
from mirage.io.types import ByteSource, materialize
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_text
from mirage.shell.job_table import JobTable
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.shell.types import NodeType as NT
from mirage.workspace.executor.jobs import handle_background
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_pipe(
    execute_node,
    commands: list[tree_sitter.Node],
    stderr_flags: list[bool],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Connect commands via pipes: stdout -> stdin."""
    current_stdin = stdin
    last_stdout: ByteSource | None = None
    child_nodes: list[ExecutionNode] = []
    ios: list[IOResult] = []
    intermediate_streams: list[ByteSource] = []

    try:
        for i, cmd in enumerate(commands):
            try:
                stdout, io, child_exec = await execute_node(
                    cmd, session, current_stdin, call_stack)
            except ExitSignal as sig:
                # Each pipeline segment is its own shell in bash: exit
                # (or ${var:?}) ends the segment, not the pipeline.
                stdout = sig.stdout
                io = IOResult(exit_code=sig.contained_code,
                              stderr=sig.stderr or None)
                child_exec = ExecutionNode(command=get_text(cmd),
                                           exit_code=sig.contained_code,
                                           stderr=sig.stderr)
            ios.append(io)
            child_nodes.append(child_exec)

            if i < len(commands) - 1:
                pipe_stderr = (i < len(stderr_flags) and stderr_flags[i])
                if pipe_stderr:
                    current_stdin = merge_stdout_stderr(stdout, io)
                else:
                    current_stdin = stdout
                if current_stdin is None:
                    current_stdin = b""
                if not isinstance(current_stdin, bytes):
                    intermediate_streams.append(current_stdin)
            last_stdout = stdout

        if last_stdout is not None and not isinstance(last_stdout, bytes):
            materialized = await run_with_timeout(
                materialize(last_stdout), session.pipeline_timeout_seconds,
                "pipeline")
            last_stdout = materialized
    finally:
        # Explicitly close any intermediate generators that may still
        # be holding resource resources (HTTP connections, file
        # handles). Harmless on exhausted streams.
        for s in intermediate_streams:
            await close_quietly(s)

    last_io = ios[-1]
    last_io.sync_exit_code()
    if session.shell_options.get("pipefail"):
        for io in ios:
            io.sync_exit_code()
        rightmost_failure = next(
            (io.exit_code for io in reversed(ios) if io.exit_code != 0), 0)
        if rightmost_failure != 0:
            last_io.exit_code = rightmost_failure
    merged_stderr_parts: list[bytes] = []
    merged_reads: dict[str, ByteSource] = {}
    merged_writes: dict[str, ByteSource] = {}
    merged_cache: list[str] = []
    for io, child in zip(ios, child_nodes):
        io.sync_exit_code()
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
    left: tree_sitter.Node,
    op: str,
    right: tree_sitter.Node,
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle &&, ||"""
    left_stdout, left_io, left_exec = await execute_node(
        left, session, stdin, call_stack)
    children = [left_exec]

    if op == NT.AND:
        left_bytes = await apply_barrier(left_stdout, left_io,
                                         BarrierPolicy.VALUE)
        session.last_exit_code = left_io.exit_code
        if left_io.exit_code != 0:
            # The failing command is left of the final `&&`, which bash
            # exempts from `set -e`.
            session.errexit_immune = True
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
        left_bytes = await apply_barrier(left_stdout, left_io,
                                         BarrierPolicy.VALUE)
        session.last_exit_code = left_io.exit_code
        if left_io.exit_code == 0:
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
    left_bytes = await apply_barrier(left_stdout, left_io, BarrierPolicy.VALUE)
    session.last_exit_code = left_io.exit_code
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
    body: list[tree_sitter.Node],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute body in isolated env.

    Args:
        execute_node (Callable): recursion bound to the subshell's own
            job table, so `wait`/`kill`/`jobs` inside see its jobs.
        body (list[tree_sitter.Node]): ALL subshell children, including
            the `&` tokens that mark background statements (named-only
            lists would run `a & b` synchronously and never set `$!`).
        session (Session): shell session; env/options snapshot-restored.
        stdin (ByteSource | None): input stream.
        call_stack (CallStack | None): function-call scope, if any.
        job_table (JobTable | None): the subshell's private job table
            (bash forks: the parent's table never sees these jobs).
        agent_id (str | None): agent identity for job bookkeeping.
    """
    saved_cwd = session.cwd
    saved_env = dict(session.env)
    saved_options = dict(session.shell_options)
    saved_readonly = set(session.readonly_vars)
    saved_arrays = {k: list(v) for k, v in session.arrays.items()}
    saved_functions = dict(session.functions)
    saved_positional = list(getattr(session, "positional_args", None) or [])
    saved_last_bg_job = session.last_bg_job_id
    saved_getopts_pos = session._getopts_pos
    saved_getopts_optind = session._getopts_optind
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
            is_bg = (i + 1 < len(body) and body[i + 1].type == NT.BACKGROUND)
            if is_bg and job_table is not None:
                stdout, io, last_exec = await handle_background(
                    execute_node, child, None, session, job_table, agent_id
                    or "", stdin, call_stack)
                merged_io = await merged_io.merge(io)
                if stdout is not None:
                    all_stdout.append(stdout)
                i += 2
                continue
            i += 1
            try:
                stdout, io, last_exec = await execute_node(
                    child, session, stdin, call_stack)
            except ExitSignal as sig:
                # A subshell is its own shell: exit (or ${var:?}) ends
                # the subshell only, becoming its exit status.
                if sig.stdout:
                    all_stdout.append(sig.stdout)
                sig_io = IOResult(exit_code=sig.contained_code,
                                  stderr=sig.stderr or None)
                merged_io = await merged_io.merge(sig_io)
                merged_io.exit_code = sig.contained_code
                last_exec = ExecutionNode(command="()",
                                          exit_code=sig.contained_code,
                                          stderr=sig.stderr)
                break
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
        session.cwd = saved_cwd
        session.env = saved_env
        session.shell_options = saved_options
        session.readonly_vars = saved_readonly
        session.arrays = saved_arrays
        session.functions = saved_functions
        session.positional_args = saved_positional
        session.last_bg_job_id = saved_last_bg_job
        session._getopts_pos = saved_getopts_pos
        session._getopts_optind = saved_getopts_optind
