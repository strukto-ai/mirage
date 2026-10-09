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
from mirage.policy import PolicyDenied
from mirage.shell.bytes import encode_text
from mirage.shell.errors import ArithError, ReadonlyError
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.shared import (
    readonly_refusal,
    refusal,
    require_view,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.elements import land_arith
from mirage.workspace.session.state import (
    random_reader,
    session_arith,
    session_view,
)
from mirage.workspace.types import ExecutionNode


async def handle_let(
    args: list[str],
    session: SessionState,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Evaluate each operand as an arithmetic expression.

    ``let`` is ``(( ))`` spelled as a builtin: every word is one
    expression, the writes each one performs land through the element
    writer in order, and the exit status is 1 when the *last* expression
    evaluated to 0 (``let a=1 b=0`` exits 1, ``let b=0 a=1`` exits 0).
    No operand at all is ``let: expression expected``, exit 1, and a
    malformed one aborts the builtin at that word with the evaluator's
    own message; the operands before it have already landed, which is
    GNU's order too. A write to a readonly name stops it the same way,
    after the writes the expression made before it (``let 'X=5, R=3'``
    leaves X at 5); one inside a subscript ends the shell.

    Args:
        args (list[str]): the words after ``let``, one expression each.
        session (SessionState): shell session state.
        state (SessionView | None): the gated session view.
    """
    if not args:
        err = b"bash: let: expression expected\n"
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="let", exit_code=1, stderr=err),
        )
    view = require_view(state)
    value = 0
    for expr in args:
        reader = random_reader(session)
        error: ArithError | ReadonlyError | None = None
        value = 0
        try:
            arith = session_arith(session, expr, reader)
            writes, value = arith.writes, arith.value
        except (ArithError, ReadonlyError) as exc:
            # bash bound the assignments made before the error; they
            # land before the error is reported.
            error, writes = exc, exc.writes
        try:
            await land_arith(session, view, writes, reader)
        except PolicyDenied as exc:
            return refusal("let", exc)
        if isinstance(error, ReadonlyError):
            if error.in_subscript:
                raise error.signal()
            return readonly_refusal("let", error.name)
        if error is not None:
            err = encode_text(f"bash: let: {expr}: {error}\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command="let", exit_code=1, stderr=err),
            )
    code = 0 if value != 0 else 1
    return (
        None,
        IOResult(exit_code=code),
        ExecutionNode(command="let", exit_code=code),
    )


async def let_builtin(call: BuiltinCall) -> Result:
    """The ``let`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_let(
        list(call.argv.args),
        call.context.session,
        session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
    )
