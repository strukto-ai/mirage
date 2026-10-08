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
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.declare.constants import (
    EXPORT_FLAGS,
    EXPORT_USAGE,
)
from mirage.workspace.executor.builtins.declare.declare import (
    declare_line,
    declared_kind,
    held_value,
    identifier_failure,
    identifier_refusal,
    kind_conflict,
    kind_listed,
    mark_functions,
    scalar_value,
    split_decl_flags,
    store_staged_arrays,
)
from mirage.workspace.executor.builtins.shared import (
    readonly_refusal,
    refusal,
    require_view,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    deref,
    exported_names,
    outlive_call,
    session_view,
    set_attr,
)
from mirage.workspace.types import ExecutionNode


def _export_lines(session: SessionState, flags: set[str]) -> list[str]:
    """Build sorted declaration lines for every exported name.

    The exported set, not every shell variable: ``X=hello`` is absent
    and ``export Y=world`` is present, which is what bash prints.
    ``-a`` / ``-A`` narrow it to exported indexed / associative arrays
    (``kind_listed``).

    Rendering is ``declare_line``'s, not a second spelling of it: GNU's
    ``export -p`` prints the *whole* cluster, so a readonly exported
    scalar is ``declare -rx R="1"`` and an exported array is
    ``declare -ax AR=([0]="a")``. Writing ``declare -x`` here by hand
    printed neither, and rendered an exported array as a bare
    ``declare -x AR`` because it looked the value up among the scalars.

    Args:
        session (SessionState): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one declaration line per exported name.
    """
    lines = [
        declare_line(session, name)
        for name in exported_names(session)
        if kind_listed(session, name, flags)
    ]
    return [line for line in lines if line is not None]


async def handle_export(
    assignments: list[str],
    session: SessionState,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Export names, or print them (``export -p`` / bare ``export``).

    With no name operands, prints every entry in ``session.env`` as
    ``declare -x NAME="value"`` (bash's ``-p`` form). Invalid option
    characters fail with status 2 and the GNU usage line. Writes go
    through the session view, so readonly refusal and the pre_session
    policy gate fire here exactly as for any other writer. ``-f`` marks
    functions instead, for a nested shell to inherit (``mark_functions``).
    ``-a`` / ``-A`` shape only an assigned value, as ``readonly``'s do;
    bash accepts them although its usage line names only ``-fn``.
    """
    flags, names, bad = split_decl_flags(assignments, EXPORT_FLAGS)
    if bad is not None:
        err = encode_text(
            f"bash: export: -{bad}: invalid option\n{EXPORT_USAGE}"
        )
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="export", exit_code=2, stderr=err),
        )
    # -n is the off direction, and applies to every spelling, since
    # `export -n K=v` assigns and unexports.
    on = "n" not in flags
    kind = declared_kind(flags)
    if "f" in flags:
        return await mark_functions(
            "export",
            session,
            session.exported_functions,
            names,
            on,
            state,
            arrays,
            kind,
        )
    # -p with names is ignored for display; bare / -p alone print.
    if not names and not arrays:
        lines = _export_lines(session, flags)
        out = encode_text(("\n".join(lines) + "\n") if lines else "")
        return out, IOResult(), ExecutionNode(command="export", exit_code=0)
    view = require_view(state)
    errors: list[str] = []
    if arrays:
        # `export ARR=(a b)` marks the array as surely as it marks a
        # scalar: GNU prints `declare -ax ARR=([0]="a" [1]="b")`.
        refused = await store_staged_arrays(
            "export",
            session,
            view,
            arrays,
            mark=VarAttr.EXPORT,
            on=on,
            fatal=True,
            kind=kind,
        )
        if refused is not None:
            return refused
    for assign in names:
        bad_name = identifier_refusal("export", assign)
        if bad_name is not None:
            errors.append(bad_name)
            continue
        key, eq, val = assign.partition("=")
        if eq and view.is_readonly(key):
            return readonly_refusal("export", key)
        # A value of the other array kind is refused and the name is
        # still marked, as bash does.
        held = held_value(session, key) if eq else None
        conflict = kind_conflict(held, kind) if eq else None
        if conflict is not None:
            errors.append(f"bash: export: {key}: {conflict}")
        if eq and conflict is None:
            value, assigned = scalar_value(held, val, kind)
            try:
                await view.set(key, value, assigned=assigned)
            except PolicyDenied as exc:
                return refusal("export", exc)
            set_attr(session, deref(session, key), VarAttr.EXPORT, on)
        else:
            # The bare form writes no value, so it marks through the
            # plane's no-value door rather than inventing an empty
            # string. On a name that does not exist yet that leaves it
            # *unset and exported*, which is bash's own third state --
            # `export Z` prints `declare -x Z` and stays out of `env`
            # until something gives it a value. Still gated: marking a
            # hidden or policy-refused name is a session write.
            try:
                await view.mark(key, VarAttr.EXPORT, on)
            except PolicyDenied as exc:
                return refusal("export", exc)
        if on:
            outlive_call(session, key)
    if errors:
        return identifier_failure("export", errors)
    return None, IOResult(), ExecutionNode(command="export", exit_code=0)


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
