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

from mirage.policy import PolicyDenied
from mirage.shell.errors import ArithError, ReadonlyVariableError
from mirage.shell.voice import shell_voice
from mirage.workspace.executor.builtins.shared import (
    fail,
    readonly_refusal,
    refusal,
    result,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import session_arith


async def handle_let(
    args: list[str],
    session: SessionState,
) -> Result:
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
    """
    if not args:
        return fail("let", f"{shell_voice()}let: expression expected\n")
    value = 0
    for expr in args:
        try:
            value = await session_arith(session, expr, expand=True)
        except PolicyDenied as exc:
            return refusal("let", exc)
        except (ArithError, ReadonlyVariableError) as exc:
            if exc.in_subscript:
                raise exc.signal() from exc
            if isinstance(exc, ReadonlyVariableError):
                return readonly_refusal("let", exc.name)
            return fail("let", f"{shell_voice()}let: {exc}\n")
    return result("let", exit_code=0 if value != 0 else 1)


async def let_builtin(call: BuiltinCall) -> Result:
    """The ``let`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_let(
        list(call.argv.args),
        call.context.session,
    )
