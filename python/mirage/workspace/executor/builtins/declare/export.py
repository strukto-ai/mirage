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

from mirage.shell.variable import VarAttr
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.declare.declare import mark_names
from mirage.workspace.executor.builtins.declare.types import (
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import session_view


async def handle_export(
    assignments: list[DeclarationOperand],
    session: SessionState,
    state: SessionView | None = None,
) -> Result:
    """Export names, or print them (``export -p`` / bare ``export``).

    The exported set, not every shell variable: ``X=hello`` is absent
    and ``export Y=world`` is present, which is what bash prints. ``-f``
    marks functions instead, for a nested shell to inherit; bash accepts
    ``-a`` / ``-A`` although its usage line names only ``-fn``
    (``mark_names``).

    Args:
        assignments (list[DeclarationOperand]): the option words, then
            the operands in order.
        session (SessionState): shell session state.
        state (SessionView | None): the gated session view.
    """
    return await mark_names(assignments, session, state, VarAttr.EXPORT)


async def export_builtin(call: BuiltinCall) -> Result:
    """The ``export`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_export(
        list(call.argv.args),
        call.context.session,
        session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
    )
