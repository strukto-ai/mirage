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
from collections.abc import Callable
from functools import partial
from typing import Any

from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.io import IOResult
from mirage.io.stream import (
    async_chain,
    close_quietly,
    discard_io,
    discard_streams,
)
from mirage.io.types import ByteSource, materialize, settled
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.process.supervisor import ProcessSupervisor
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole, JobOutput
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.console.types import Channel
from mirage.shell.constants import (
    ERREXIT_EXEMPT_TYPES,
    FORK_FAILED,
    FORK_FAILED_STATUS,
)
from mirage.shell.descriptors import ENCLOSING, Recorder
from mirage.shell.errors import ExitSignal, PipeClosed, ReturnSignal
from mirage.shell.job_table import JobTable, JobWaits
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec
from mirage.workspace.evaluation import (
    EvaluationContext,
    reset_current_evaluation,
    set_current_evaluation,
)
from mirage.workspace.executor.builtins.exec import divert_statement
from mirage.workspace.executor.control import UNWINDING, carried, ended
from mirage.workspace.executor.jobs import handle_background, pump
from mirage.workspace.executor.statement import (
    carry_status,
    fd0_binding,
    finish_statement,
    land,
    record_status,
    statement_output,
    statement_stdin,
)
from mirage.workspace.executor.traps import (
    end_shell,
    inherit_exit_trap,
    run_exit_trap,
)
from mirage.workspace.types import ExecutionNode


async def handle_pipe(
    execute_node,
    commands: list[TSNodeLike],
    stderr_flags: list[bool],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    processes: ProcessSupervisor | None = None,
    execute_fn: Callable[..., Any] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Connect commands via pipes: stdout -> stdin.

    Each stage is a child shell, which runs its own EXIT action through
    ``execute_fn`` when it ends.
    """
    session = context.session
    # Reassociated pipelines can enter here without execute_node resetting
    # the parent. An exemption belongs to the preceding statement only;
    # the caller applies this pipeline's own negation after it finishes.
    session.errexit_immune = False
    pipes = [
        PipeConsole(i < len(stderr_flags) and stderr_flags[i])
        for i in range(len(commands))
    ]
    ios: list[IOResult] = [IOResult() for _ in commands]
    child_nodes: list[ExecutionNode] = [ExecutionNode() for _ in commands]

    children = [context.fork() for _ in commands]

    async def run_segment(i: int, cmd: TSNodeLike) -> int:
        child_evaluation = children[i]
        child = child_evaluation.session
        inherit_exit_trap(child)
        child.terminal_output = (
            session.terminal_output and i == len(commands) - 1
        )
        token = set_current_evaluation(child_evaluation)
        output = pipes[i]
        input_stream = stdin if i == 0 else pipes[i - 1].stream()
        io = IOResult()
        child_exec = ExecutionNode()
        stage_stack = (call_stack or CallStack()).fork()
        # A job a stage before the last starts writes into the pipe, and
        # the reader sees end of input only once the job has closed it.
        waits = None
        if i < len(commands) - 1:
            piped = i < len(stderr_flags) and stderr_flags[i]
            waits = JobWaits(
                JobOutput(output),
                frozenset({Channel.STDOUT, Channel.STDERR})
                if piped
                else frozenset({Channel.STDOUT}),
            )
            child.job_output = waits.output
            child.job_waits = waits
        rest = session.job_output or session.tty.jobs
        try:
            stdout, io, child_exec = await end_shell(
                execute_fn,
                child,
                input_stream,
                stage_stack,
                execute_node(
                    cmd,
                    child_evaluation,
                    input_stream,
                    stage_stack,
                    sink=output,
                ),
            )
            await pump(output, Channel.STDOUT, stdout)
            await pump(output, Channel.STDERR, io.stderr)
            if waits is not None:
                await waits.join(rest)
        except PipeClosed:
            io.exit_code = 141
        except UNWINDING as sig:
            # A stage is a subshell: whatever unwinds ends it there.
            unwound = ended(sig)
            io.exit_code = unwound.exit_code
            await pump(output, Channel.STDOUT, unwound.stdout)
            await pump(output, Channel.STDERR, unwound.stderr)
            if waits is not None:
                await waits.join(rest)
        except BaseException as error:
            output.end(error)
            raise
        finally:
            child.functions.clear()
            if i > 0:
                pipes[i - 1].close_reader()
            if input_stream is not None and not isinstance(
                input_stream, bytes
            ):
                await close_quietly(input_stream)
            output.end()
            io.stderr = await output.snapshot(Channel.STDERR)
            ios[i] = io
            child_nodes[i] = child_exec
            reset_current_evaluation(token)
        return io.exit_code

    tasks: list[asyncio.Task[int]] = []
    failed = False
    try:
        for i, cmd in enumerate(commands):
            if processes is None:
                tasks.append(asyncio.create_task(run_segment(i, cmd)))
                continue
            try:
                process = processes.start(
                    session_id=session.session_id,
                    command=decode_text(cmd.text or b""),
                    cwd=PathSpec.from_str_path(session.cwd),
                    parent_pid=session.process_id,
                    run=partial(run_segment, i, cmd),
                    limit=session.processes.max,
                )
            except BlockingIOError as exc:
                raise ExitSignal(
                    FORK_FAILED_STATUS, stderr=FORK_FAILED
                ) from exc
            children[i].session.process_id = process.info.pid
            tasks.append(process.task)
        result = await run_with_timeout(
            asyncio.gather(materialize(pipes[-1].stream()), *tasks),
            session.pipeline_timeout_seconds,
            "pipeline",
        )
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
        for evaluation in children:
            evaluation.session.functions.clear()
        if failed:
            for io in ios:
                await discard_io(io)
            # The shell's own fd 0 outlives the line, as bash's does:
            # the next line reads on from it.
            if stdin is not session.exec_stdin:
                await discard_streams(stdin)

    last_io = ios[-1]
    # Parked for the boundary that closes this statement to claim as
    # `${PIPESTATUS[@]}`: the raw per-segment statuses, before pipefail
    # rewrites the pipeline's own.
    session._pipe_status_pending = tuple(io.exit_code for io in ios)
    if session.shell_options.get("pipefail"):
        rightmost_failure = next(
            (io.exit_code for io in reversed(ios) if io.exit_code != 0), 0
        )
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
        merged_reads = {
            p: v
            for p, v in merged_reads.items()
            if p not in io.writes or not settled(v)
        }
        merged_reads.update(io.reads)
        merged_writes.update(io.writes)
        merged_cache = [p for p in merged_cache if p not in io.writes]
        merged_cache.extend(io.cache)

    if merged_stderr_parts:
        last_io.stderr = b"".join(merged_stderr_parts)
    last_io.reads = merged_reads
    last_io.writes = merged_writes
    last_io.cache = merged_cache

    exec_node = ExecutionNode(
        op="|", exit_code=last_io.exit_code, children=child_nodes
    )
    return last_stdout, last_io, exec_node


async def handle_connection(
    execute_node,
    left: TSNodeLike,
    op: str,
    right: TSNodeLike,
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle &&, ||"""
    session = context.session
    bound = fd0_binding(session)
    left_stdout, left_io, left_exec = await execute_node(
        left, context, stdin, call_stack
    )
    children = [left_exec]

    left_bytes = await finish_statement(left_stdout, left_io, session, left)
    if (op == NT.AND and left_io.exit_code != 0) or (
        op == NT.OR and left_io.exit_code == 0
    ):
        if op == NT.AND:
            session.errexit_immune = True
        carry_status(session)
        return (
            left_bytes,
            left_io,
            ExecutionNode(
                op=str(op), exit_code=left_io.exit_code, children=children
            ),
        )

    try:
        right_stdout, right_io, right_exec = await execute_node(
            right, context, statement_stdin(session, stdin, bound), call_stack
        )
    except UNWINDING as sig:
        raise await carried(sig, left_bytes, left_io)
    children.append(right_exec)
    # Materialize right side to match && and || behavior, ensuring
    # lazy exit codes (e.g. from exit_on_empty) are finalized before
    # the combined stream is returned to the caller.
    right_bytes = await materialize(right_stdout)
    merged = await left_io.merge(right_io)
    combined = async_chain([left_bytes, right_bytes])
    return (
        combined,
        merged,
        ExecutionNode(
            op=str(op), exit_code=merged.exit_code, children=children
        ),
    )


async def handle_subshell(
    execute_node,
    body: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    dispatch: DispatchFn | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
    sink: JobConsole | None = None,
    execute_fn: Callable[..., Any] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a subshell's body in the child shell its caller made.

    Args:
        execute_node (Callable): recursion bound to the subshell's own
            job table, so `wait`/`kill`/`jobs` inside see its jobs.
        body (list[TSNodeLike]): ALL subshell children, including
            the `&` tokens that mark background statements (named-only
            lists would run `a & b` synchronously and never set `$!`).
        context (EvaluationContext): the process owner's isolated child session.
        stdin (ByteSource | None): input stream.
        call_stack (CallStack | None): function-call scope, if any.
        job_table (JobTable | None): the subshell's private job table
            (bash forks: the parent's table never sees these jobs).
        agent_id (str | None): agent identity for job bookkeeping.
        dispatch (DispatchFn | None): the op door, so a subshell honors
            an `exec` redirect the way the program loop does. A subshell
            is a child shell, so its redirects leave the parent unchanged.
        sink (JobConsole | None): where each statement's output goes as
            it finishes; the body is a shell of its own, which routes
            what it wrote to its terminal through a copy, so a program
            nested in it (``$( )``, ``eval``) leaves that to it.
        execute_fn (Callable[..., Any] | None): runs the subshell's own
            EXIT action as it ends.
    """
    session = context.session
    inherit_exit_trap(session)
    session.job_output = JobOutput(session.job_output or session.tty.jobs)
    session._line_open = True
    # A child shell: `shift` or `set --` in it leaves the caller's
    # parameters alone, and it runs in none of the caller's loops.
    call_stack = (call_stack or CallStack()).fork(loops=False)
    all_stdout: list[Any] = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="()", exit_code=0)
    bound = fd0_binding(session)
    i = 0
    while i < len(body):
        child = body[i]
        if not child.is_named or child.type == NT.COMMENT:
            i += 1
            continue

        # `set -n` needs no arm here: `execute_node` refuses every
        # node while the option is on, so this loop simply runs a
        # tail of no-ops. The child owns the option, so it cannot
        # leak to the parent.
        is_bg = i + 1 < len(body) and body[i + 1].type == NT.BACKGROUND
        if is_bg and job_table is not None:
            try:
                stdout, io, last_exec = await handle_background(
                    execute_node,
                    child,
                    None,
                    context,
                    job_table,
                    agent_id or "",
                    stdin,
                    call_stack,
                    handed,
                    decisions,
                )
            except ExitSignal as sig:
                # A job the subshell cannot fork ends the subshell
                # only, its status the subshell's.
                merged_io = await merged_io.merge(
                    IOResult(
                        exit_code=sig.contained_code,
                        stderr=sig.stderr or None,
                    )
                )
                merged_io.exit_code = sig.contained_code
                record_status(session, sig.contained_code)
                last_exec = ExecutionNode(
                    command="()",
                    exit_code=sig.contained_code,
                    stderr=sig.stderr,
                )
                break
            merged_io = await merged_io.merge(io)
            # Seed $? for later body commands (mirrors program loop).
            record_status(session, io.exit_code)
            if stdout is not None:
                all_stdout.append(stdout)
            i += 2
            continue
        i += 1
        child_stdin = statement_stdin(session, stdin, bound)
        recorder = Recorder()
        enclosing = ENCLOSING.set(recorder)
        jobs = session.job_output
        held = jobs.recorder
        try:
            jobs.recorder = recorder
            try:
                stdout, io, last_exec = await execute_node(
                    child, context, child_stdin, call_stack, sink=recorder
                )
            finally:
                jobs.recorder = held
        except (ExitSignal, ReturnSignal) as sig:
            # A subshell is its own shell: exit (or ${var:?}) ends
            # the subshell only, becoming its exit status, and so
            # does the `return` of a function it runs in.
            merged_io = await land(
                await statement_output(
                    recorder,
                    sig.stdout or None,
                    IOResult(),
                    session.terminal,
                    sink,
                ),
                sink,
                all_stdout,
                merged_io,
            )
            status = ended(sig).exit_code
            sig_io = IOResult(exit_code=status, stderr=sig.stderr or None)
            merged_io = await merged_io.merge(sig_io)
            merged_io.exit_code = status
            record_status(session, status)
            last_exec = ExecutionNode(
                command="()", exit_code=status, stderr=sig.stderr
            )
            break
        finally:
            ENCLOSING.reset(enclosing)
        stdout = await finish_statement(stdout, io, session, child, last_exec)
        written = await divert_statement(
            dispatch,
            session,
            await statement_output(
                recorder, stdout, io, session.terminal, sink
            ),
            io,
            child,
            last_exec.command or "",
        )
        merged_io = await land(written, sink, all_stdout, merged_io)
        merged_io = await merged_io.merge(io)
        if (
            io.exit_code != 0
            and session.shell_options.get("errexit")
            and child.type not in ERREXIT_EXEMPT_TYPES
            and not session.errexit_immune
        ):
            merged_io.exit_code = io.exit_code
            break
    # The EXIT action is the subshell's: its `wait` and `jobs` see the
    # subshell's jobs, not the caller's.
    if execute_fn is not None and job_table is not None:
        execute_fn = partial(execute_fn, job_table=job_table)
    cleanup = await run_exit_trap(
        execute_fn, session, merged_io.exit_code, stdin, call_stack
    )
    if cleanup is not None:
        merged_io = await land(
            [
                (channel, data, False)
                for channel, data in (
                    (Channel.STDOUT, await cleanup.materialize_stdout()),
                    (Channel.STDERR, await cleanup.materialize_stderr()),
                )
                if data
            ],
            sink,
            all_stdout,
            merged_io,
        )
        merged_io.exit_code = cleanup.exit_code
        last_exec = ExecutionNode(command="()", exit_code=cleanup.exit_code)
    if len(all_stdout) == 1:
        return all_stdout[0], merged_io, last_exec
    combined = async_chain(all_stdout) if all_stdout else None
    return combined, merged_io, last_exec
