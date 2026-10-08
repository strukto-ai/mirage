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
from mirage.shell.errors import ArithError
from mirage.shell.variable import ShellVar, VarAttr, VarKind
from mirage.workspace.executor.builtins.declare.declare import (
    declaration_result,
    drop_reference,
    held_value,
    identifier_refusal,
    kind_conflict,
    local_attrs,
    nameref_refusal,
    plus_refusal,
    premark,
    reach_global,
    scalar_value,
    stamp_marks,
    start_local,
    store_staged_arrays,
)
from mirage.workspace.executor.builtins.shared import (
    arith_refusal,
    readonly_line,
    refusal,
    require_view,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    deref,
    env_get,
    in_call_env,
    session_view,
    shadow_local,
    visible_arrays,
    visible_assocs,
)
from mirage.workspace.types import ExecutionNode


async def handle_local(
    assignments: list[str],
    session: SessionState,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
    cmd: str = "local",
    kind: VarKind | None = None,
    shaping: frozenset[VarAttr] = frozenset(),
    marks: tuple[tuple[VarAttr, bool], ...] = (),
    plus: str = "",
    nameref: bool = False,
    global_scope: bool = False,
    inherit: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Declare names in the running function's scope, or globally.

    Each operand is declared and marked before the next one runs, as
    bash does: ``declare -r R=1 R=2`` freezes ``R`` at 1 and refuses the
    second write, which fails the builtin while the later operands
    still declare. Array literals store first, and the marks land on
    them once every literal has stored (``store_staged_arrays``).

    Args:
        assignments (list[str]): ``NAME`` / ``NAME=value`` operands.
        session (SessionState): shell session state.
        state (SessionView | None): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the declaration.
        cmd (str): the spelling that reached here, for diagnostics.
            ``declare`` and ``typeset`` route through this handler and
            must say their own name, not ``local``.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared, so
            staged literals build that kind of array.
        shaping (frozenset[VarAttr]): the value-shaping attributes
            (``-i -l -u``) the declaration carries. They are marked on
            each name *before* its value stores, after the local
            snapshot, so the declaration's own value coerces exactly as
            a later write would: GNU stores ``7`` for
            ``declare -i n=3+4`` and ``hello`` for ``declare -l s=HeLLo``.
        marks (tuple[tuple[VarAttr, bool], ...]): the attribute letters
            to put on or take off each operand once it lands
            (``stamp_marks``), readonly last.
        plus (str): the ``+`` letters, for the two that cannot be taken
            off (``plus_refusal``).
        nameref (bool): the declaration carried ``-n``, so a value names
            the reference's target and is stored on the reference's own
            record, which also takes the marks, rather than written
            through an existing one.
        global_scope (bool): the declaration carried ``-g``, so inside a
            function the names are declared globally: no local snapshot
            is taken, and a name the function already shadows has its
            *global* record read, written and marked (``reach_global``).
        inherit (bool): the declaration carried ``-I``, so a new local
            keeps the shadowed variable's value and attributes but a
            reference (``start_local``).
    """
    if cmd == "local" and session._local_vars is None:
        # `local` is the one spelling that needs a function scope;
        # `declare`/`typeset` share this handler and are legal at top
        # level. Without the check the builtin took its operands, stored
        # them globally and exited 0, which is the silent-accept this
        # whole tier exists to remove.
        err = b"bash: local: can only be used in a function\n"
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command=cmd, exit_code=1, stderr=err),
        )
    view = require_view(state)
    restore = (
        reach_global(
            session,
            [a.partition("=")[0] for a in assignments]
            + [name for name, _, _ in arrays or []],
        )
        if global_scope
        else None
    )
    try:
        return await _declare_operands(
            assignments,
            session,
            view,
            arrays or [],
            cmd,
            kind,
            shaping,
            marks,
            plus,
            nameref,
            None if global_scope else session._local_vars,
            inherit,
        )
    finally:
        if restore is not None:
            restore()


async def _declare_operands(
    assignments: list[str],
    session: SessionState,
    view: SessionView,
    arrays: list[tuple[str, bool, list[str]]],
    cmd: str,
    kind: VarKind | None,
    shaping: frozenset[VarAttr],
    marks: tuple[tuple[VarAttr, bool], ...],
    plus: str,
    nameref: bool,
    local_vars: dict[str, ShellVar | None] | None,
    inherit: bool,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``handle_local``'s operands in the scope it settled on.

    Args:
        assignments (list[str]): ``NAME`` / ``NAME=value`` operands.
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]]): staged literals.
        cmd (str): the builtin's spelling, for diagnostics.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.
        shaping (frozenset[VarAttr]): the ``-i -l -u`` attributes.
        marks (tuple[tuple[VarAttr, bool], ...]): the attribute marks.
        plus (str): the ``+`` letters.
        nameref (bool): the declaration carried ``-n``.
        local_vars (dict[str, ShellVar | None] | None): the running
            frame, None at global scope.
        inherit (bool): the declaration carried ``-I``.
    """
    errors: list[str] = []
    warnings: list[str] = []
    stored: list[str] = []
    try:
        refused = await store_staged_arrays(
            cmd,
            session,
            view,
            arrays,
            errors,
            warnings,
            fatal=session._local_vars is None,
            stored=stored,
            kind=kind,
            shaping=shaping,
            global_scope=local_vars is None,
            inherit=inherit,
        )
        if refused is not None:
            return refused
        for name in stored:
            line = plus_refusal(cmd, session, view, name, plus)
            if line is not None:
                errors.append(line)
                continue
            await stamp_marks(session, view, name, deref(session, name), marks)
        for assign in assignments:
            line = await _declare_operand(
                session,
                view,
                assign,
                cmd,
                kind,
                shaping,
                marks,
                plus,
                nameref,
                local_vars,
                inherit,
            )
            if line is not None:
                errors.append(line)
    except PolicyDenied as exc:
        return refusal(cmd, exc)
    except ArithError as exc:
        return arith_refusal(cmd, exc)
    return declaration_result(cmd, errors, warnings)


async def _declare_operand(
    session: SessionState,
    view: SessionView,
    assign: str,
    cmd: str,
    kind: VarKind | None,
    shaping: frozenset[VarAttr],
    marks: tuple[tuple[VarAttr, bool], ...],
    plus: str,
    nameref: bool,
    local_vars: dict[str, ShellVar | None] | None,
    inherit: bool,
) -> str | None:
    """Declare one ``NAME`` / ``NAME=value`` operand and mark it.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        assign (str): the operand.
        cmd (str): the builtin's spelling, for diagnostics.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.
        shaping (frozenset[VarAttr]): the ``-i -l -u`` attributes.
        marks (tuple[tuple[VarAttr, bool], ...]): the attribute marks.
        plus (str): the ``+`` letters.
        nameref (bool): the declaration carried ``-n``.
        local_vars (dict[str, ShellVar | None] | None): the running
            frame, None at global scope.
        inherit (bool): the declaration carried ``-I``.

    Returns:
        The operand's refusal line, or None when it declared.

    Raises:
        PolicyDenied: the gate refused a write or a mark.
        ArithError: an ``-i`` value did not evaluate.
    """
    bad_name = identifier_refusal(cmd, assign)
    if bad_name is not None:
        return bad_name
    key, eq, val = assign.partition("=")
    fresh = local_vars is not None and key not in local_vars
    if not eq:
        if local_vars is not None:
            shadow_local(session, local_vars, key)
        if fresh:
            line = await _fresh_local(session, view, cmd, key, inherit)
            if line is not None:
                return line
        line = plus_refusal(cmd, session, view, key, plus)
        if line is not None:
            return line
        if (
            env_get(session, key) is None
            and key not in visible_arrays(session)
            and key not in visible_assocs(session)
        ):
            # Declared, not assigned. `local L` leaves the name *unset*,
            # exactly as `export Z` does: GNU prints `declare -- L` and
            # `${L-d}` still expands to `d`. A bare declaration of an
            # existing array re-scopes it, so nothing is written there.
            # Visible reads: a hidden name counts as unset, so the mark
            # is attempted and the door refuses it.
            await view.mark(key, None, True, not nameref)
        await stamp_marks(session, view, key, None, marks, not nameref)
        return None
    if nameref:
        bad_ref = nameref_refusal(cmd, key, val)
        if bad_ref is not None:
            return bad_ref
    if view.is_readonly(key):
        return readonly_line(cmd, key)
    if local_vars is not None:
        shadow_local(session, local_vars, key)
    if fresh and not in_call_env(session, key):
        start_local(session, key, inherit)
    line = plus_refusal(cmd, session, view, key, plus)
    if line is not None:
        return line
    # A new local holds nothing of the caller's but what `start_local`
    # kept; otherwise the value lands as any declaration's does
    # (`scalar_value`), and an array kind the variable cannot take is
    # refused.
    held = (
        None
        if nameref or (fresh and not inherit)
        else held_value(session, key)
    )
    conflict = kind_conflict(held, kind)
    if conflict is not None:
        return f"bash: {cmd}: {key}: {conflict}"
    value, assigned = (val, None) if nameref else scalar_value(held, val, kind)
    checked = key if nameref else deref(session, key)
    await premark(view, key, shaping)
    if kind is not None and not nameref:
        await drop_reference(session, view, key)
    await view.set(key, value, follow_ref=not nameref, assigned=assigned)
    await stamp_marks(session, view, key, checked, marks, not nameref)
    return None


async def _fresh_local(
    session: SessionState,
    view: SessionView,
    cmd: str,
    name: str,
    inherit: bool = False,
) -> str | None:
    """Start a new bare ``local NAME`` unset, as bash 5.2 does.

    Only a name the frame did not shadow yet: a second ``local x``, or
    the fresh array ``local -a x`` has already put in place, keeps what
    the function holds.

    The caller's value and attributes stay behind except the export
    mark: GNU prints ``declare -- x`` for ``x=1; f() { local x; }`` and
    ``declare -x x`` for an exported one, and ``local x; x+=y`` stores
    ``y`` (``local_attrs``). With ``-I`` the value and attributes stay,
    a reference's aside. A name the call assigned in front is the
    exception and keeps that value (``x=1 f`` where f runs ``local x``
    reads 1). A readonly name refuses, as GNU's does, and the operands
    after it still declare.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        cmd (str): the builtin's spelling, for the diagnostic.
        name (str): the name being declared.
        inherit (bool): the declaration carried ``-I``.

    Returns:
        The readonly refusal line, else None.

    Raises:
        PolicyDenied: the gate refused the reset.
    """
    var = session.vars.get(name)
    if var is None or in_call_env(session, name):
        return None
    if view.is_readonly(name):
        return readonly_line(cmd, name)
    if inherit:
        if VarAttr.NAMEREF in var.attrs:
            await view.mark(name, VarAttr.NAMEREF, False)
        return None
    await view.unset(name, follow_ref=False)
    for attr in local_attrs(var, inherit):
        await view.mark(name, attr, True)
    return None


async def local_builtin(call: BuiltinCall) -> Result:
    """The ``local`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_local(
        list(call.argv.args),
        call.context.session,
        session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
    )
