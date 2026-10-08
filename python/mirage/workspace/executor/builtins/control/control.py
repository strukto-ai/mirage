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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.workspace.executor.builtins.shared import (
    builtin_error,
    is_count_word,
    numeric_operands,
    status_of,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.control import BreakSignal, ContinueSignal
from mirage.workspace.executor.traps import run_exit_trap
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_true() -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``true``: succeed and print nothing."""
    return None, IOResult(), ExecutionNode(command="true", exit_code=0)


async def handle_colon() -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``:``: succeed and print nothing (the null command)."""
    return None, IOResult(), ExecutionNode(command=":", exit_code=0)


async def handle_false() -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``false``: fail with 1 and print nothing."""
    return (
        None,
        IOResult(exit_code=1),
        ExecutionNode(command="false", exit_code=1),
    )


async def handle_return(
    args: list[str],
    session: SessionState,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Return from a function or sourced script, with bash's checks.

    bash reads the status before it looks for a function to leave, so a
    bad one is reported even where ``return`` then refuses.

    Args:
        args (list[str]): words after the command name; at most one,
            the return status.
        session (SessionState): session whose last exit code is the default
            status.
        call_stack (CallStack | None): active call stack; a pushed
            frame (a function's or a sourced file's) is what returns.
    """
    args = numeric_operands(args)
    status = session.last_exit_code
    err = b""
    if args and not is_count_word(args[0]):
        err = builtin_error("return", f"{args[0]}: numeric argument required")
        status = 2
    elif len(args) > 1:
        # bash abandons everything still to run, as `exit 1 2` does.
        raise ExitSignal(
            1, stderr=builtin_error("return", "too many arguments")
        )
    elif args:
        status = status_of(args[0])
    if call_stack is None or not call_stack.returnable:
        # bash prints the diagnostic, sets $? to 2, and carries on with
        # the rest of the line.
        err += builtin_error(
            "return", "can only `return' from a function or sourced script"
        )
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="return", exit_code=2, stderr=err),
        )
    raise ReturnSignal(status, stderr=err)


async def handle_exit(
    args: list[str],
    session: SessionState,
    execute_fn: Callable[..., Any] | None = None,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Exit the shell, with bash's argument checks, running its EXIT
    action first, where ``exit`` was called: a function's locals and
    ``$1`` are still in scope, as they are for bash's.

    Args:
        args (list[str]): words after the command name; at most one,
            the exit status.
        session (SessionState): session whose last exit code is the default
            status.
        execute_fn (Callable[..., Any] | None): runs the EXIT action.
        stdin (ByteSource | None): the shell's standard input, which
            the action reads.
        call_stack (CallStack | None): the frames ``exit`` was called in.
    """
    args = numeric_operands(args)
    err = b""
    if args and not is_count_word(args[0]):
        # bash exits with 2 after the diagnostic.
        code = 2
        err = builtin_error("exit", f"{args[0]}: numeric argument required")
    elif len(args) > 1:
        # bash abandons everything still to run, and exits nowhere.
        code = 1
        err = builtin_error("exit", "too many arguments")
    elif args:
        code = status_of(args[0])
    else:
        bare = session._trap_status
        code = (bare if bare is not None else session.last_exit_code) % 256
    cleanup = await run_exit_trap(execute_fn, session, code, stdin, call_stack)
    if cleanup is None:
        raise ExitSignal(code, stderr=err)
    leaving = ExitSignal(
        cleanup.exit_code,
        stderr=err + await cleanup.materialize_stderr(),
        stdout=await cleanup.materialize_stdout(),
    )
    leaving.cleanup = leaving.stdout or b""
    raise leaving


def leave_loops(
    name: str,
    args: list[str],
    session: SessionState,
    call_stack: CallStack | None,
) -> Result:
    """``break`` or ``continue`` as bash 5.2 reads its count.

    The loops are the current frame's: a function starts outside its
    caller's, and so does a ``( )`` or ``&`` child. Outside every loop
    the builtin only complains; a count past the loops is the loops; a
    count below 1 ends them all, ``continue`` included, and fails. A
    word that is no number throws to the top level with 128 over ``$?``,
    and a second word abandons everything still to run.

    Args:
        name (str): ``break`` or ``continue``.
        args (list[str]): words after the builtin name.
        session (SessionState): whose ``$?`` a bad count builds on.
        call_stack (CallStack | None): the frames; the current one's
            loops are the ones it can leave.
    """
    loops = call_stack.current.loop_level if call_stack is not None else 0
    if loops == 0:
        err = builtin_error(
            name, "only meaningful in a `for', `while', or `until' loop"
        )
        return (
            None,
            IOResult(stderr=err),
            ExecutionNode(command=name, stderr=err),
        )
    args = numeric_operands(args)
    if args and not is_count_word(args[0]):
        raise ExitSignal(
            session.last_exit_code | 128,
            stderr=builtin_error(
                name, f"{args[0]}: numeric argument required"
            ),
        )
    if len(args) > 1:
        raise ExitSignal(1, stderr=builtin_error(name, "too many arguments"))
    count = int(args[0]) if args else 1
    if count <= 0:
        err = builtin_error(name, f"{args[0]}: loop count out of range")
        raise BreakSignal(io=IOResult(exit_code=1, stderr=err), levels=loops)
    signal = BreakSignal if name == "break" else ContinueSignal
    raise signal(levels=min(count, loops))


async def true_builtin(call: BuiltinCall) -> Result:
    """The ``true`` arm.

    Args:
        call (BuiltinCall): the invocation, unread.
    """
    return await handle_true()


async def colon_builtin(call: BuiltinCall) -> Result:
    """The ``:`` arm.

    Args:
        call (BuiltinCall): the invocation, unread.
    """
    return await handle_colon()


async def false_builtin(call: BuiltinCall) -> Result:
    """The ``false`` arm.

    Args:
        call (BuiltinCall): the invocation, unread.
    """
    return await handle_false()


async def return_builtin(call: BuiltinCall) -> Result:
    """The ``return`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_return(
        list(call.argv.args), call.context.session, call.call_stack
    )


async def exit_builtin(call: BuiltinCall) -> Result:
    """The ``exit`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_exit(
        list(call.argv.args),
        call.context.session,
        call.execute_fn,
        call.stdin,
        call.call_stack,
    )


async def break_builtin(call: BuiltinCall) -> Result:
    """The ``break`` arm: unwinds the enclosing loops by raising.

    Args:
        call (BuiltinCall): the invocation.
    """
    return leave_loops(
        "break", list(call.argv.args), call.context.session, call.call_stack
    )


async def continue_builtin(call: BuiltinCall) -> Result:
    """The ``continue`` arm: unwinds to the next iteration by raising.

    Args:
        call (BuiltinCall): the invocation.
    """
    return leave_loops(
        "continue", list(call.argv.args), call.context.session, call.call_stack
    )
