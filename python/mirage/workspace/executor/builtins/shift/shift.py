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
from mirage.workspace.executor.builtins.shared import is_count_word
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_shift(
    args: list[str],
    call_stack: CallStack | None,
    session: Session | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Shift positional parameters, with bash's argument checks.

    A count past ``$#`` shifts nothing and exits 1 with no message, a
    negative count is ``shift count out of range``, and a non-numeric
    word is ``numeric argument required``; every other case exits 0.

    Args:
        args (list[str]): words after the command name; at most one,
            the shift count.
        call_stack (CallStack | None): function-call positional frames.
        session (Session | None): shell session state.
    """
    if len(args) > 1:
        err = b"shift: too many arguments\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    if args and not is_count_word(args[0]):
        err = f"shift: {args[0]}: numeric argument required\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    n = int(args[0]) if args else 1
    if n < 0:
        err = f"shift: {args[0]}: shift count out of range\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="shift",
                                                         exit_code=1)
    # bash: a count past `$#` shifts nothing and returns 1, silently.
    if call_stack is not None and call_stack.get_all_positional():
        if n > call_stack.get_positional_count():
            return None, IOResult(exit_code=1), ExecutionNode(command="shift",
                                                              exit_code=1)
        call_stack.shift(n)
    elif session is not None:
        if n > len(session.positional_args):
            return None, IOResult(exit_code=1), ExecutionNode(command="shift",
                                                              exit_code=1)
        session.positional_args = session.positional_args[n:]
    return None, IOResult(), ExecutionNode(command="shift", exit_code=0)


async def shift_builtin(call: BuiltinCall) -> Result:
    """The ``shift`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_shift(list(call.argv.args),
                              call.call_stack,
                              session=call.session)
