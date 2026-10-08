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
from mirage.shell.bytes import encode_text
from mirage.shell.variable import VarAttr, VarKind
from mirage.workspace.executor.builtins.declare.constants import (
    READONLY_FLAGS,
    READONLY_USAGE,
)
from mirage.workspace.executor.builtins.declare.declare import (
    declare_line,
    declared_kind,
    kind_listed,
    mark_functions,
    mark_variables,
    split_decl_flags,
)
from mirage.workspace.executor.builtins.declare.types import (
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.shared import require_view
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    env_is_readonly,
)
from mirage.workspace.types import ExecutionNode


def _readonly_lines(session: SessionState, flags: set[str]) -> list[str]:
    """Build sorted readonly lines, each the name's ``declare -p`` line.

    ``-a`` narrows the listing to indexed arrays and ``-A`` to
    associative ones, the way bash does (``kind_listed``). The whole
    attribute cluster prints, ``declare -ir`` and ``declare -arx``, as
    bash's does.

    Args:
        session (SessionState): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one declaration line per selected name.
    """
    # env_is_readonly answers False for a hidden name, so a hidden
    # readonly never prints even its bare `declare -r NAME` row.
    lines = [
        declare_line(session, name)
        for name in sorted(
            n for n in session.readonly_vars if env_is_readonly(session, n)
        )
        if kind_listed(session, name, flags)
    ]
    return [line for line in lines if line is not None]


async def handle_readonly(
    assignments: list[DeclarationOperand],
    session: SessionState,
    state: SessionView | None = None,
    kind: VarKind | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Mark names readonly, or print them (``readonly -p`` / bare form).

    With no name operands, prints every readonly name as ``declare -p``
    does. Invalid options fail with status 2. ``-a`` / ``-A`` shape only
    an assigned value (``scalar_value``, ``mark_variables``): a bare
    ``readonly -a NAME`` marks the name and converts nothing.

    ``-f`` freezes *functions*: a frozen one refuses redefinition and
    ``unset -f`` with its own message, exit 1, and the old body stays
    (``mark_functions``). With no names, ``-f`` lists the frozen
    functions, each body followed by its ``declare -fr NAME`` line.
    """
    flags, names, bad = split_decl_flags(assignments, READONLY_FLAGS)
    if bad is not None:
        err = encode_text(
            f"bash: readonly: -{bad}: invalid option\n{READONLY_USAGE}"
        )
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="readonly", exit_code=2, stderr=err),
        )
    kind = kind or declared_kind(flags)
    if "f" in flags:
        return await mark_functions(
            "readonly",
            session,
            session.readonly_functions,
            names,
            True,
            state,
            kind,
        )
    if not names:
        lines = _readonly_lines(session, flags)
        out = encode_text(("\n".join(lines) + "\n") if lines else "")
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    return await mark_variables(
        "readonly",
        session,
        require_view(state),
        names,
        VarAttr.READONLY,
        True,
        kind,
    )
