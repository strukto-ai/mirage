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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.workspace.executor.builtins.shared import is_count_word
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.control import BreakSignal, ContinueSignal
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def loop_levels(args: list[str]) -> int:
    """Parse the optional numeric level of ``break``/``continue``.

    Args:
        args (list[str]): words after the builtin name.
    """
    if args and args[0].isdigit() and int(args[0]) > 0:
        return int(args[0])
    return 1


async def handle_true() -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``true``: succeed and print nothing."""
    return None, IOResult(), ExecutionNode(command="true", exit_code=0)


async def handle_colon() -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``:``: succeed and print nothing (the null command)."""
    return None, IOResult(), ExecutionNode(command=":", exit_code=0)


async def handle_false() -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``false``: fail with 1 and print nothing."""
    return None, IOResult(exit_code=1), ExecutionNode(command="false",
                                                      exit_code=1)


async def handle_return(
    args: list[str],
    session: SessionState,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Return from a function or sourced script, with bash's checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the return status.
        session (SessionState): session whose last exit code is the default
            status and whose source depth marks sourced execution.
        call_stack (CallStack | None): active call stack; a pushed
            frame marks function execution.
    """
    in_function = call_stack is not None and call_stack.depth > 1
    if not in_function and session.source_depth == 0:
        # bash prints the diagnostic, sets $? to 2, and carries on with
        # the rest of the line.
        err = (b"return: can only `return' from a function "
               b"or sourced script\n")
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=2,
                                                         stderr=err)
    if args and not is_count_word(args[0]):
        # bash prints the error and the function returns 2.
        raise ReturnSignal(
            2,
            stderr=f"return: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        err = b"return: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="return",
                                                         exit_code=1,
                                                         stderr=err)
    # A bare return propagates the status of the last command executed.
    raise ReturnSignal(int(args[0]) % 256 if args else session.last_exit_code)


async def handle_exit(
    args: list[str],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Exit the shell, with bash's argument checks.

    Args:
        args (list[str]): words after the command name; at most one,
            the exit status.
        session (SessionState): session whose last exit code is the default
            status.
    """
    if args and not is_count_word(args[0]):
        # bash exits with 2 after the diagnostic.
        raise ExitSignal(
            2, stderr=f"exit: {args[0]}: numeric argument required\n".encode())
    if len(args) > 1:
        # bash refuses to exit and the command fails with 1.
        err = b"exit: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="exit",
                                                         exit_code=1,
                                                         stderr=err)
    code = int(args[0]) if args else session.last_exit_code
    raise ExitSignal(code % 256)


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
    return await handle_return(list(call.argv.args), call.session,
                               call.call_stack)


async def exit_builtin(call: BuiltinCall) -> Result:
    """The ``exit`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_exit(list(call.argv.args), call.session)


async def break_builtin(call: BuiltinCall) -> Result:
    """The ``break`` arm: unwinds the enclosing loops by raising.

    Args:
        call (BuiltinCall): the invocation.
    """
    raise BreakSignal(levels=loop_levels(list(call.argv.args)))


async def continue_builtin(call: BuiltinCall) -> Result:
    """The ``continue`` arm: unwinds to the next iteration by raising.

    Args:
        call (BuiltinCall): the invocation.
    """
    raise ContinueSignal(levels=loop_levels(list(call.argv.args)))
