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
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.shared import (
    builtin_error,
    is_count_word,
    numeric_operands,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    positional_params,
    set_positional_params,
)
from mirage.workspace.types import ExecutionNode


async def handle_shift(
    args: list[str],
    call_stack: CallStack | None,
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Shift positional parameters, with bash's argument checks.

    A count past ``$#`` shifts nothing and exits 1 with no message, a
    negative count is ``shift count out of range``, and a non-numeric
    word is ``numeric argument required``; every other case exits 0.

    Args:
        args (list[str]): words after the command name; at most one,
            the shift count.
        call_stack (CallStack | None): function-call positional frames.
        session (SessionState): shell session state.
    """
    args = numeric_operands(args)
    if args and not is_count_word(args[0]):
        err = builtin_error("shift", f"{args[0]}: numeric argument required")
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="shift", exit_code=1),
        )
    if len(args) > 1:
        # bash abandons everything still to run, as `exit 1 2` does.
        raise ExitSignal(
            1, stderr=builtin_error("shift", "too many arguments")
        )
    n = int(args[0]) if args else 1
    if n < 0:
        err = builtin_error("shift", f"{args[0]}: shift count out of range")
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="shift", exit_code=1),
        )
    params = positional_params(session, call_stack)
    # bash: a count past `$#` shifts nothing and returns 1, silently.
    if n > len(params):
        return (
            None,
            IOResult(exit_code=1),
            ExecutionNode(command="shift", exit_code=1),
        )
    set_positional_params(session, call_stack, params[n:])
    return None, IOResult(), ExecutionNode(command="shift", exit_code=0)


async def shift_builtin(call: BuiltinCall) -> Result:
    """The ``shift`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_shift(
        list(call.argv.args), call.call_stack, session=call.context.session
    )
