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
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.arith import evaluate_arith
from mirage.shell.errors import ArithError
from mirage.workspace.executor.builtins.shared import (readonly_refusal,
                                                       refusal, require_view)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import (ensure_var_visible, random_reader,
                                            session_elements, session_view,
                                            visible_env)
from mirage.workspace.types import ExecutionNode


async def handle_let(
    args: list[str],
    session: Session,
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
    GNU's order too.

    Args:
        args (list[str]): the words after ``let``, one expression each.
        session (Session): shell session state.
        state (SessionView | None): the session plane's gated door.
    """
    if not args:
        err = b"bash: let: expression expected\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="let",
                                                         exit_code=1,
                                                         stderr=err)
    view = require_view(state)
    value = 0
    for expr in args:
        reader = random_reader(session)
        error: ArithError | None = None
        value = 0
        try:
            arith = evaluate_arith(expr,
                                   visible_env(session),
                                   elements=session_elements(session, reader),
                                   read_var=reader.read,
                                   wrote_var=reader.wrote)
            writes, value = arith.writes, arith.value
        except ArithError as exc:
            # bash bound the assignments made before the error; they
            # land before the error is reported.
            error, writes = exc, exc.writes
        for write in writes:
            try:
                ensure_var_visible(session, write.name)
            except PolicyDenied as exc:
                return refusal("let", exc)
            if view.is_readonly(write.name):
                return readonly_refusal("let", write.name)
        try:
            for write in writes:
                await assign_element(session, view, write.name, write.key,
                                     write.value)
            reader.settle()
        except PolicyDenied as exc:
            return refusal("let", exc)
        if error is not None:
            err = f"bash: let: {expr}: {error}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="let",
                                                             exit_code=1,
                                                             stderr=err)
    code = 0 if value != 0 else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="let",
                                                         exit_code=code)


async def let_builtin(call: BuiltinCall) -> Result:
    """The ``let`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_let(
        list(call.argv.args), call.session,
        session_view(call.session, call.namespace.registry.policies))
