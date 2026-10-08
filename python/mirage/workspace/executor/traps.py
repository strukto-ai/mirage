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
from mirage.shell.constants import ERR_TRAP_EXEMPT_TYPES
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.workspace.executor.statement import (
    Written,
    as_written,
    record_status,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def inherit_traps(session: SessionState) -> None:
    """Start a child shell: ``( )``, a pipeline stage, a job, ``$( )``.

    The session's ``exit_trap`` is the ``trap ... EXIT`` action, "" for
    an ignored EXIT. A child shell keeps its parent's with
    ``exit_trap_inherited`` set: it lists it, as bash's ``trap -p`` does
    there, and runs none of it until it registers its own. It keeps the
    ERR action hidden unless ``set -E`` and the RETURN action unless
    ``set -T``, and lists them all the same. It is live shell state,
    which a session store keeps none of.

    Args:
        session (SessionState): the child's state.
    """
    session.exit_trap_inherited = session.exit_trap is not None
    session._trap_status = None
    if not session.shell_options.get("errtrace"):
        session.err_trap_hidden = True
    if not session.shell_options.get("functrace"):
        session.return_trap_hidden = True


def clear_traps(session: SessionState) -> None:
    """Start a new shell (``bash -c``, a script): it has no actions.

    Args:
        session (SessionState): the new shell's state.
    """
    session.exit_trap = None
    session.exit_trap_inherited = False
    session._trap_status = None
    session.err_trap = session.return_trap = None
    session.err_trap_hidden = session.return_trap_hidden = False
    session.err_trap_running = session.return_trap_running = False


def lift_function_traps(
    session: SessionState,
) -> tuple[str | None, str | None]:
    """Take the caller's ERR and RETURN actions from a function's body
    unless ``set -E`` / ``set -T``: the body neither runs nor lists them.

    Args:
        session (SessionState): the shell calling the function.

    Returns:
        tuple[str | None, str | None]: the ERR and RETURN actions taken,
        for ``restore_function_traps``.
    """
    err_trap = return_trap = None
    if (
        session.err_trap
        and not session.err_trap_hidden
        and not session.shell_options.get("errtrace")
    ):
        err_trap, session.err_trap = session.err_trap, None
    if (
        session.return_trap
        and not session.return_trap_hidden
        and not session.shell_options.get("functrace")
    ):
        return_trap, session.return_trap = session.return_trap, None
    return err_trap, return_trap


def restore_function_traps(
    session: SessionState, lifted: tuple[str | None, str | None]
) -> None:
    """Give the actions ``lift_function_traps`` took back as the function
    returns, each unless the body set one of its own, as bash does.

    Args:
        session (SessionState): the shell the function returns to.
        lifted (tuple[str | None, str | None]): what was taken.
    """
    err_trap, return_trap = lifted
    if err_trap is not None and session.err_trap is None:
        session.err_trap = err_trap
    if return_trap is not None and session.return_trap is None:
        session.return_trap = return_trap


def err_trap_armed(session: SessionState) -> bool:
    """Whether the ERR action is set and seen here, taken as a statement
    starts: bash answers a failure only when the action was armed before
    the command ran, so a function that sets one is not answered for.

    Args:
        session (SessionState): the shell about to run the statement.
    """
    return bool(session.err_trap) and not session.err_trap_hidden


async def run_err_trap(
    execute_fn: Callable[..., Any] | None,
    node: TSNodeLike,
    status: int,
    session: SessionState,
    armed: bool,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    exec_node: ExecutionNode | None = None,
) -> list[Written]:
    """Run the ERR action after a statement finished with ``status``.

    It runs where ``set -e`` would act: not in a test, the left of
    ``&&``/``||`` or after ``!``, and not again for a group, ``if``, a
    loop, ``case`` or ``&&``/``||`` list, whose own failing command ran
    it already, unless the statement failed to open a redirect and never
    ran. ``$?`` is ``status`` while it runs and again after it, whatever
    the action returns, and the action does not run while it is running,
    nor once ``set -e`` is ending the shell. An ``exit`` or ``return`` in
    it leaves as the statement's would. Hidden in a function or a child
    shell unless ``set -E``, as bash's is.

    Args:
        execute_fn (Callable[..., Any] | None): runs a line in the
            caller's frames; None where nothing can run one.
        node (TSNodeLike): the statement, its redirects included.
        status (int): its status.
        session (SessionState): the shell it ran in.
        armed (bool): ``err_trap_armed`` as the statement started.
        stdin (ByteSource | None): the shell's standard input.
        call_stack (CallStack | None): the frames the action runs in.
        exec_node (ExecutionNode | None): the statement's node, whose
            ``unopened`` mark (a redirect of it failed to open) this
            consumes, so a group returning the same node does not answer
            the failure again.

    Returns:
        list[Written]: what the action wrote, for the caller to land;
        empty when none runs.
    """
    action = session.err_trap
    unopened = exec_node is not None and exec_node.unopened
    if exec_node is not None:
        exec_node.unopened = False
    if node.type == NT.REDIRECTED_STATEMENT and node.children:
        node = node.children[0]
    if (
        not armed
        or status == 0
        or execute_fn is None
        or not action
        or session.err_trap_hidden
        or session.err_trap_running
        or session.errexit_exiting
        or session.errexit_immune
        or session.errexit_ignored
        or (
            node.type in ERR_TRAP_EXEMPT_TYPES
            and not unopened
            and not _arithmetic(node)
        )
    ):
        return []
    # `$?` is the failed status while the action runs; a list's right
    # command has not recorded it yet.
    record_status(session, status, transparent=True)
    session.err_trap_running = True
    try:
        return await _run_action(
            execute_fn, action, session, status, stdin, call_stack
        )
    finally:
        session.err_trap_running = False


def _arithmetic(node: TSNodeLike) -> bool:
    """Whether a statement is ``(( ... ))``, which the grammar parses as a
    compound statement but bash runs as a command of its own.

    Args:
        node (TSNodeLike): the statement.
    """
    return (
        node.type == NT.COMPOUND_STATEMENT
        and bool(node.children)
        and node.children[0].type == "(("
    )


async def run_return_trap(
    execute_fn: Callable[..., Any] | None,
    session: SessionState,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> list[Written]:
    """Run the RETURN action as a function or a sourced file returns.

    It runs in the frames of what is returning, with ``$?`` as the last
    command left it; what returns keeps its own status. Hidden in a
    function or a child shell unless ``set -T`` or it set its own, and
    it does not run while it is running, nor once ``set -e`` is ending
    the shell.

    Args:
        execute_fn (Callable[..., Any] | None): runs a line in the
            caller's frames; None where nothing can run one.
        session (SessionState): the shell returning.
        stdin (ByteSource | None): the shell's standard input.
        call_stack (CallStack | None): the returning frames.

    Returns:
        list[Written]: what the action wrote, for the caller to land;
        empty when none runs.
    """
    action = session.return_trap
    if (
        execute_fn is None
        or not action
        or session.return_trap_hidden
        or session.return_trap_running
        or session.errexit_exiting
    ):
        return []
    session.return_trap_running = True
    try:
        return await _run_action(
            execute_fn,
            action,
            session,
            session.last_exit_code,
            stdin,
            call_stack,
        )
    finally:
        session.return_trap_running = False


async def _run_action(
    execute_fn: Callable[..., Any],
    action: str,
    session: SessionState,
    status: int,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
) -> list[Written]:
    """Run a trap action as a line of the shell and collect its output.
    ``$?`` is ``status`` again after it, whatever the action returns, and
    what the action runs in a test or after ``!`` leaves the ``set -e``
    answer for the statement it answers as it was.

    Args:
        execute_fn (Callable[..., Any]): runs a line in the caller's
            frames.
        action (str): the action's text.
        session (SessionState): the shell running it.
        status (int): the ``$?`` it leaves.
        stdin (ByteSource | None): the shell's standard input.
        call_stack (CallStack | None): the frames it runs in.
    """
    immune = session.errexit_immune
    try:
        io = await execute_fn(
            action,
            session_id=session.session_id,
            stdin=stdin,
            call_stack=call_stack if call_stack is not None else CallStack(),
        )
    finally:
        session.errexit_immune = immune
    record_status(session, status)
    return as_written(
        await materialize(io.stdout), await materialize(io.stderr)
    )


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
    # Its own commands answer ERR and RETURN afresh; the failure that set
    # `-e` off was answered already.
    exiting = session.errexit_exiting
    session.errexit_exiting = False
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
        session.errexit_exiting = exiting
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
