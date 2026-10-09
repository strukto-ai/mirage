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
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.session import SessionState


async def handle_readonly(
    assignments: list[DeclarationOperand],
    session: SessionState,
    state: SessionView | None = None,
) -> Result:
    """Mark names readonly, or print them (``readonly -p`` / bare form).

    ``-f`` freezes *functions*: a frozen one refuses redefinition and
    ``unset -f`` with its own message, exit 1, and the old body stays.
    With no names, ``-f`` lists the frozen functions, each body followed
    by its ``declare -fr NAME`` line (``mark_names``).

    Args:
        assignments (list[DeclarationOperand]): the option words, then
            the operands in order.
        session (SessionState): shell session state.
        state (SessionView | None): the gated session view.
    """
    return await mark_names(assignments, session, state, VarAttr.READONLY)
