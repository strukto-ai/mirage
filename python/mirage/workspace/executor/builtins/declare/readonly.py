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
from mirage.shell.bytes import encode_text
from mirage.shell.errors import ArithError
from mirage.shell.variable import VarAttr, VarKind
from mirage.workspace.executor.builtins.declare.constants import (
    READONLY_FLAGS,
    READONLY_USAGE,
)
from mirage.workspace.executor.builtins.declare.declare import (
    declare_line,
    declared_kind,
    identifier_failure,
    identifier_refusal,
    kind_conflict,
    kind_listed,
    mark_functions,
    premark,
    scalar_value,
    split_decl_flags,
    store_staged_arrays,
)
from mirage.workspace.executor.builtins.shared import (
    arith_refusal,
    readonly_refusal,
    refusal,
    require_view,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    env_is_readonly,
    outlive_call,
    set_attr,
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
    assignments: list[str],
    session: SessionState,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
    stored: list[str] | None = None,
    kind: VarKind | None = None,
    shaping: frozenset[VarAttr] = frozenset(),
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Mark names readonly, or print them (``readonly -p`` / bare form).

    With no name operands, prints every readonly name as ``declare -p``
    does. Invalid options fail with status 2. ``-a`` / ``-A`` shape only
    an assigned value (``scalar_value``, ``store_staged_arrays``): a bare
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
            arrays,
            kind,
        )
    if not names and not arrays:
        lines = _readonly_lines(session, flags)
        out = encode_text(("\n".join(lines) + "\n") if lines else "")
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    view = require_view(state)
    errors: list[str] = []
    if arrays:
        refused = await store_staged_arrays(
            "readonly",
            session,
            view,
            arrays,
            mark=VarAttr.READONLY,
            fatal=True,
            stored=stored,
            kind=kind,
            errors=errors,
            shaping=shaping,
        )
        if refused is not None:
            return refused
    for assign in names:
        bad_name = identifier_refusal("readonly", assign)
        if bad_name is not None:
            errors.append(bad_name)
            continue
        key, eq, val = assign.partition("=")
        if eq and view.is_readonly(key):
            return readonly_refusal("readonly", key)
        # A value of the other array kind is refused and the name is
        # still frozen, as bash does.
        conflict = kind_conflict(session, key, kind) if eq else None
        if conflict is not None:
            errors.append(f"bash: readonly: {key}: {conflict}")
        if eq and conflict is None:
            try:
                await premark(view, key, shaping)
                await view.set(key, scalar_value(session, key, val, kind))
            except PolicyDenied as exc:
                return refusal("readonly", exc)
            except ArithError as exc:
                return arith_refusal("readonly", exc)
            # Ungated: the `view.set` above already put this name
            # through the gate, so the mark rides on that decision.
            set_attr(session, key, VarAttr.READONLY)
            if stored is not None:
                stored.append(key)
        else:
            # Gated, exactly as `export NAME` is. The bare form writes no
            # value, so it has no `view.set` to ride on, and marking
            # through `set_attr` walked straight past `pre_session`: a
            # deployment refusing `AWS_*` still saw `readonly AWS_KEY`
            # exit 0, create the record, and freeze the name against
            # every later legitimate write.
            try:
                await view.mark(key, VarAttr.READONLY, True)
            except PolicyDenied as exc:
                return refusal("readonly", exc)
            if stored is not None:
                stored.append(key)
        outlive_call(session, key)
    if errors:
        return identifier_failure("readonly", errors)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)
