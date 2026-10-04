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

from collections.abc import Awaitable, Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, materialize
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.workspace.executor.statement import record_status
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def inherit_exit_trap(session: SessionState) -> None:
    """Start a child shell: ``( )``, a pipeline stage, a job, ``$( )``.

    The session's ``exit_trap`` is the ``trap ... EXIT`` action, "" for
    an ignored EXIT. A child shell keeps its parent's with
    ``exit_trap_inherited`` set: it lists it, as bash's ``trap -p`` does
    there, and runs none of it until it registers its own. It is live
    shell state, which a session store keeps none of.

    Args:
        session (SessionState): the child's state.
    """
    session.exit_trap_inherited = session.exit_trap is not None
    session._trap_status = None


def clear_exit_trap(session: SessionState) -> None:
    """Start a new shell (``bash -c``, a script): it has no EXIT action.

    Args:
        session (SessionState): the new shell's state.
    """
    session.exit_trap = None
    session.exit_trap_inherited = False
    session._trap_status = None


async def run_exit_trap(
    execute_fn: Callable[..., Any] | None,
    session: SessionState,
    status: int,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> IOResult | None:
    """Run the shell's EXIT action as the shell ends with ``status``.

    bash clears the action before it runs it, and an ``exit`` in it, or
    one it registers there, does not run again.
    ``$?`` starts at ``status``, and a bare ``exit`` keeps it. The status
    the shell ends with stays ``status`` unless the action exits, or
    fails under ``set -e``, which exits too. Hard stops (cancellation, a
    killed job, a closed workspace) are not an end the shell reaches,
    and never get here.

    Args:
        execute_fn (Callable[..., Any] | None): runs a line in the
            caller's frames; None where nothing can run one.
        session (SessionState): the shell that is ending.
        status (int): the status it ends with.
        stdin (ByteSource | None): the shell's standard input.
        call_stack (CallStack | None): the frames the action runs in:
            the function that called ``exit`` is still on them.

    Returns:
        IOResult | None: what the action wrote and the shell's final
        status; None when no action of this shell's own is set.
    """
    action = session.exit_trap
    if (
        execute_fn is None
        or action is None
        or session.exit_trap_inherited
        or session._trap_status is not None
    ):
        return None
    session.exit_trap = None
    if not action:
        return None
    record_status(session, status)
    # The status the shell is ending with, while the action runs: a bare
    # `exit` in it keeps it, as bash's does.
    saved = session._trap_status
    session._trap_status = status
    final = status
    try:
        io = await execute_fn(
            action,
            session_id=session.session_id,
            stdin=stdin,
            call_stack=call_stack if call_stack is not None else CallStack(),
        )
        stdout = await materialize(io.stdout) or b""
        stderr = await materialize(io.stderr) or b""
        # Only a failure `set -e` acts on ends the shell: one in a test,
        # the left of `&&`/`||` or after `!` leaves the status alone.
        if (
            io.exit_code != 0
            and session.shell_options.get("errexit")
            and not session.errexit_immune
        ):
            final = io.exit_code
    except ExitSignal as sig:
        stdout, stderr, final = sig.stdout or b"", sig.stderr, sig.exit_code
    except ReturnSignal as sig:
        stdout = await materialize(sig.stdout) or b""
        stderr = sig.stderr
    finally:
        session._trap_status = saved
        session.exit_trap = None
        session.exit_trap_inherited = False
    record_status(session, final)
    return IOResult(stdout=stdout, stderr=stderr or None, exit_code=final)


async def finish_shell(
    execute_fn: Callable[..., Any] | None,
    session: SessionState,
    io: IOResult,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> IOResult:
    """End a child shell whose line returned ``io``: a ``bash -c``, a
    script, a ``$( )``. Its EXIT action runs after what it wrote.

    Args:
        execute_fn (Callable[..., Any] | None): runs the action.
        session (SessionState): the child shell, before it is restored.
        io (IOResult): what the child's line produced.
        stdin (ByteSource | None): the child's standard input.
        call_stack (CallStack | None): the child's frames.
    """
    cleanup = await run_exit_trap(
        execute_fn, session, io.exit_code, stdin, call_stack
    )
    if cleanup is None:
        return io
    return IOResult(
        stdout=async_chain([io.stdout, cleanup.stdout]),
        stderr=(await io.materialize_stderr())
        + (await cleanup.materialize_stderr())
        or None,
        exit_code=cleanup.exit_code,
        reads=io.reads,
        writes=io.writes,
        cache=io.cache,
        refusal=io.refusal,
    )


async def end_shell(
    execute_fn: Callable[..., Any] | None,
    session: SessionState,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    body: Awaitable[tuple[ByteSource | None, IOResult, ExecutionNode]],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the whole of a child shell, a pipeline stage or a job, then
    its EXIT action. An ``exit`` or a fatal error that ends it carries
    the action's output and status on out to the boundary containing
    it.

    Args:
        execute_fn (Callable[..., Any] | None): runs the action.
        session (SessionState): the child shell.
        stdin (ByteSource | None): its standard input.
        call_stack (CallStack | None): its frames.
        body (Awaitable): the child's run.
    """
    try:
        stdout, io, exec_node = await body
    except ExitSignal as sig:
        cleanup = await run_exit_trap(
            execute_fn, session, sig.contained_code, stdin, call_stack
        )
        if cleanup is not None:
            sig.stdout = (sig.stdout or b"") + (
                await cleanup.materialize_stdout()
            )
            sig.stderr += await cleanup.materialize_stderr()
            sig.exit_code = sig.contained_code = cleanup.exit_code
        raise
    except ReturnSignal as sig:
        cleanup = await run_exit_trap(
            execute_fn, session, sig.exit_code, stdin, call_stack
        )
        if cleanup is not None:
            sig.stdout = async_chain([sig.stdout, cleanup.stdout])
            sig.stderr += await cleanup.materialize_stderr()
            sig.exit_code = cleanup.exit_code
        raise
    if session.exit_trap is None or session.exit_trap_inherited:
        return stdout, io, exec_node
    stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    cleanup = await run_exit_trap(
        execute_fn, session, io.exit_code, stdin, call_stack
    )
    if cleanup is None:
        return stdout, io, exec_node
    io = await io.merge(IOResult(stderr=cleanup.stderr))
    io.exit_code = exec_node.exit_code = cleanup.exit_code
    return async_chain([stdout, cleanup.stdout]), io, exec_node
