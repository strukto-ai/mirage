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
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.declare.constants import (EXPORT_FLAGS,
                                                                  EXPORT_USAGE)
from mirage.workspace.executor.builtins.declare.declare import (
    declare_line, identifier_failure, identifier_refusal, split_decl_flags,
    store_staged_arrays)
from mirage.workspace.executor.builtins.shared import (readonly_refusal,
                                                       refusal, require_view)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (exported_names, session_view,
                                            set_attr)
from mirage.workspace.types import ExecutionNode


def _export_lines(session: SessionState, flags: set[str]) -> list[str]:
    """Build sorted declaration lines for every exported name.

    The exported set, not every shell variable: ``X=hello`` is absent
    and ``export Y=world`` is present, which is what bash prints. ``-f``
    selects shell functions instead of variables; mirage tracks no
    export attribute on functions, so that form lists nothing, as bash
    does with none exported.

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
    if "f" in flags:
        return []
    lines = [declare_line(session, name) for name in exported_names(session)]
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
    policy gate fire here exactly as for any other writer.
    """
    flags, names, bad = split_decl_flags(assignments, EXPORT_FLAGS)
    if bad is not None:
        err = (f"bash: export: -{bad}: invalid option\n"
               f"{EXPORT_USAGE}").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="export",
                                                         exit_code=2,
                                                         stderr=err)
    # -p with names is ignored for display; bare / -p alone print.
    if not names and not arrays:
        lines = _export_lines(session, flags)
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="export", exit_code=0)
    # -f is accepted and marks nothing: mirage carries no export
    # attribute on functions. -n is the off direction, and applies to
    # both spellings, since `export -n K=v` assigns and unexports.
    view = require_view(state)
    on = "n" not in flags
    if arrays:
        # `export ARR=(a b)` marks the array as surely as it marks a
        # scalar: GNU prints `declare -ax ARR=([0]="a" [1]="b")`.
        refused = await store_staged_arrays("export",
                                            session,
                                            view,
                                            arrays,
                                            mark=VarAttr.EXPORT,
                                            on=on,
                                            fatal=True)
        if refused is not None:
            return refused
    errors: list[str] = []
    for assign in names:
        bad_name = identifier_refusal("export", assign)
        if bad_name is not None:
            errors.append(bad_name)
            continue
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return readonly_refusal("export", key)
            try:
                await view.set(key, val)
            except PolicyDenied as exc:
                return refusal("export", exc)
            set_attr(session, key, VarAttr.EXPORT, on)
        else:
            # The bare form writes no value, so it marks through the
            # plane's no-value door rather than inventing an empty
            # string. On a name that does not exist yet that leaves it
            # *unset and exported*, which is bash's own third state --
            # `export Z` prints `declare -x Z` and stays out of `env`
            # until something gives it a value. Still gated: marking a
            # hidden or policy-refused name is a session write.
            try:
                await view.mark(assign, VarAttr.EXPORT, on)
            except PolicyDenied as exc:
                return refusal("export", exc)
    if errors:
        return identifier_failure("export", errors)
    return None, IOResult(), ExecutionNode(command="export", exit_code=0)


async def export_builtin(call: BuiltinCall) -> Result:
    """The ``export`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_export(
        list(call.argv.args), call.session,
        session_view(call.session, call.namespace.registry.policies))
