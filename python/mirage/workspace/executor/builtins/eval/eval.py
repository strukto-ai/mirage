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
from mirage.shell.console import JobConsole
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_eval(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: SessionState,
    stdin: ByteSource | None = None,
    sink: JobConsole | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the words as a line of the caller's own: in its frame, so
    ``$1``, ``local``, ``shift`` and ``return`` act on the function the
    caller is in, and a ``break``, ``continue`` or ``exit`` on its loops
    and shell.

    Args:
        execute_fn (Callable): runs a nested line.
        args (list[str]): the words, joined with spaces.
        session (SessionState): shell session state.
        stdin (ByteSource | None): the caller's standard input.
        sink (JobConsole | None): where the line's statements write.
        call_stack (CallStack | None): the caller's frames.
    """
    script = " ".join(args)
    io = await execute_fn(
        script,
        session_id=session.session_id,
        stdin=stdin,
        sink=sink,
        call_stack=call_stack,
    )
    return io.stdout, io, ExecutionNode(command="eval", exit_code=io.exit_code)


async def eval_builtin(call: BuiltinCall) -> Result:
    """The ``eval`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_eval(
        call.execute_fn,
        list(call.argv.args),
        call.context.session,
        call.stdin,
        call.sink,
        call.call_stack,
    )
