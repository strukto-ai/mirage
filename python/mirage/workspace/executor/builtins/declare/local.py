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
from mirage.shell.errors import ArithError
from mirage.shell.variable import ShellVar, VarAttr, VarKind, appended
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.declare.constants import SUBSCRIPT_RE
from mirage.workspace.executor.builtins.declare.declare import (
    declaration_result,
    drop_reference,
    held_value,
    identifier_refusal,
    kind_conflict,
    local_attrs,
    nameref_refusal,
    operand_parts,
    plus_refusal,
    premark,
    reference_refusal,
    scalar_value,
    stamp_marks,
    start_local,
    store_staged_arrays,
    visible_record,
)
from mirage.workspace.executor.builtins.declare.types import (
    AttrMarks,
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.shared import (
    is_valid_name,
    readonly_line,
    refusal,
    require_view,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    deref,
    env_get,
    evaluate_integer,
    in_call_env,
    reach_global,
    session_view,
    shadow_local,
    visible_arrays,
    visible_assocs,
)
from mirage.workspace.types import ExecutionNode


async def handle_local(
    assignments: list[DeclarationOperand],
    session: SessionState,
    state: SessionView | None = None,
    cmd: str = "local",
    kind: VarKind | None = None,
    shaping: AttrMarks = (),
    marks: AttrMarks = (),
    plus: str = "",
    nameref: bool = False,
    global_scope: bool = False,
    inherit: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Declare names in the running function's scope, or globally.

    bash's two passes (``store_staged_arrays``): every array literal
    stores first, then each operand in order is declared and marked
    before the next one runs, a literal's name at its own place. So
    ``declare -r R=1 R=2`` freezes ``R`` at 1 and refuses the second
    write, which fails the builtin while the later operands still
    declare, and ``declare -r R=1 R=(2)`` leaves ``(1)``.

    Args:
        assignments (list[DeclarationOperand]): the operands in order:
            ``NAME``, ``NAME=value``, ``NAME+=value`` and staged array
            literals.
        session (SessionState): shell session state.
        state (SessionView | None): the session plane's gated door.
        cmd (str): the spelling that reached here, for diagnostics.
            ``declare`` and ``typeset`` route through this handler and
            must say their own name, not ``local``.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared, so
            staged literals build that kind of array.
        shaping (AttrMarks): the value-shaping marks (``-i -l -u``,
            ``+i +l +u``) the declaration carries. They go on or off each
            name *before* its value stores, after the local snapshot, so
            the declaration's own value coerces exactly as a later write
            would: GNU stores ``7`` for ``declare -i n=3+4``, ``hello``
            for ``declare -l s=HeLLo`` and ``5x`` for ``declare +i
            N+=x`` over an integer 5.
        marks (AttrMarks): the attribute letters
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
            [
                operand_parts(a)[0] if isinstance(a, str) else a[0]
                for a in assignments
            ],
        )
        if global_scope
        else None
    )
    try:
        return await _declare_operands(
            assignments,
            session,
            view,
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
    operands: list[DeclarationOperand],
    session: SessionState,
    view: SessionView,
    cmd: str,
    kind: VarKind | None,
    shaping: AttrMarks,
    marks: AttrMarks,
    plus: str,
    nameref: bool,
    local_vars: dict[str, ShellVar | None] | None,
    inherit: bool,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run ``handle_local``'s operands in the scope it settled on.

    Args:
        operands (list[DeclarationOperand]): the operands in order.
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        cmd (str): the builtin's spelling, for diagnostics.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.
        shaping (AttrMarks): the ``-i -l -u`` / ``+i +l +u`` marks.
        marks (AttrMarks): the attribute marks.
        plus (str): the ``+`` letters.
        nameref (bool): the declaration carried ``-n``.
        local_vars (dict[str, ShellVar | None] | None): the running
            frame, None at global scope.
        inherit (bool): the declaration carried ``-I``.
    """
    errors: list[str] = []
    warnings: list[str] = []
    stored: dict[int, str] = {}
    try:
        refused = await store_staged_arrays(
            cmd,
            session,
            view,
            operands,
            errors,
            warnings,
            fatal=session._local_vars is None,
            stored=stored,
            kind=kind,
            shaping=shaping,
            global_scope=local_vars is None,
            inherit=inherit,
        )
        for position, operand in enumerate(operands):
            if isinstance(operand, str):
                line = (
                    None
                    if refused is not None
                    else await _declare_operand(
                        session,
                        view,
                        operand,
                        cmd,
                        kind,
                        shaping,
                        marks,
                        plus,
                        nameref,
                        local_vars,
                        inherit,
                    )
                )
            elif position in stored:
                # A literal takes its marks at its place, against the
                # target its own write cleared, even when a policy refused
                # a later literal; under `-n` they go on the reference,
                # which an array cannot become and a frozen one refuses,
                # its own `-i -l -u` coming off unless asked for
                # (`_unshaped`).
                name = operand[0]
                line = (
                    _literal_reference_refusal(session, view, cmd, name)
                    if nameref
                    else None
                ) or plus_refusal(cmd, session, view, name, plus)
                if line is None:
                    await stamp_marks(
                        session,
                        view,
                        name,
                        stored[position],
                        _unshaped(marks) if nameref else marks,
                        not nameref,
                    )
            else:
                continue
            if line is not None:
                errors.append(line)
        if refused is not None:
            return refused
    except PolicyDenied as exc:
        return refusal(cmd, exc)
    except ArithError as exc:
        raise exc.signal(cmd, fatal=True) from exc
    return declaration_result(cmd, errors, warnings)


def _literal_reference_refusal(
    session: SessionState, view: SessionView, cmd: str, name: str
) -> str | None:
    """The line a ``-n`` array literal earns on the reference it was
    written through: an array cannot become one, and a frozen one keeps
    every mark (``declare -nr r=t; declare -n r=(3)`` writes ``t`` and
    refuses ``r``), as bash's does.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        cmd (str): the builtin's spelling, for diagnostics.
        name (str): the literal's name.
    """
    line = reference_refusal(cmd, name, visible_record(session, name), False)
    if line is None and view.is_readonly(name, False):
        return readonly_line(cmd, name)
    return line


async def _declare_operand(
    session: SessionState,
    view: SessionView,
    assign: str,
    cmd: str,
    kind: VarKind | None,
    shaping: AttrMarks,
    marks: AttrMarks,
    plus: str,
    nameref: bool,
    local_vars: dict[str, ShellVar | None] | None,
    inherit: bool,
) -> str | None:
    """Declare one ``NAME``, ``NAME=value`` or ``NAME+=value`` operand
    and mark it.

    A ``-n`` declaration writes the reference itself, so a frozen
    reference refuses it (``declare -rn r=T; declare -n r=U``) even when
    what it points at is writable.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        assign (str): the operand.
        cmd (str): the builtin's spelling, for diagnostics.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared.
        shaping (AttrMarks): the ``-i -l -u`` / ``+i +l +u`` marks.
        marks (AttrMarks): the attribute marks.
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
    key, append, val = operand_parts(assign)
    fresh = local_vars is not None and key not in local_vars
    if nameref:
        # The reference's own `-i -l -u` come off unless asked for, as
        # bash's do (`declare -l x=T; declare -n x=U` aims at `U`); its
        # target's stay.
        shaping, marks = _unshaped(shaping), _unshaped(marks)
    if val is None:
        if local_vars is not None:
            shadow_local(session, local_vars, key)
        if fresh:
            line = await _fresh_local(session, view, cmd, key, inherit)
            if line is not None:
                return line
        if nameref:
            line = reference_refusal(
                cmd, key, visible_record(session, key), True
            )
            if line is None and view.is_readonly(key, False):
                line = readonly_line(cmd, key)
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
    if nameref and not append and val:
        # A value that names no variable refuses first, before a local
        # is made; an empty one, and what `+=` builds, are judged once
        # the name may take a reference (`_aim_reference`).
        bad_ref = nameref_refusal(cmd, key, val)
        if bad_ref is not None:
            return bad_ref
    creates = fresh and not in_call_env(session, key)
    if (creates or not nameref) and view.is_readonly(key, not nameref):
        return readonly_line(cmd, key)
    if local_vars is not None:
        shadow_local(session, local_vars, key)
    if creates:
        start_local(session, key, inherit)
    if nameref:
        # Checked on the local, which exists from here on even when the
        # array it inherited cannot become a reference, as bash's does,
        # so the function's later writes stay its own. A name no local
        # replaces reports its array before its readonly mark.
        bad_ref = reference_refusal(
            cmd, key, visible_record(session, key), False
        )
        if bad_ref is None and view.is_readonly(key, False):
            bad_ref = readonly_line(cmd, key)
        if bad_ref is not None:
            return bad_ref
    line = plus_refusal(cmd, session, view, key, plus)
    if line is not None:
        return line
    if nameref:
        return await _aim_reference(
            session, view, cmd, key, append, val, shaping, marks, creates
        )
    # A new local holds nothing of the caller's but what `start_local`
    # kept; otherwise the value lands as any declaration's does
    # (`scalar_value`), and an array kind the variable cannot take is
    # refused.
    held = None if fresh and not inherit else held_value(session, key)
    conflict = kind_conflict(held, kind)
    if conflict is not None:
        return f"bash: {cmd}: {key}: {conflict}"
    checked = deref(session, key)
    await premark(view, key, shaping)
    target = session.vars.get(checked)
    integer = target is not None and VarAttr.INTEGER in target.attrs
    value, assigned = scalar_value(held, val, kind, append, integer)
    if kind is not None:
        await drop_reference(session, view, key)
    await view.set(key, value, assigned=assigned)
    await stamp_marks(session, view, key, checked, marks)
    return None


def _unshaped(marks: AttrMarks) -> AttrMarks:
    """``marks`` taking off each of ``-i -l -u`` they do not name.

    Args:
        marks (AttrMarks): a ``-n`` declaration's marks.
    """
    named = {attr for attr, _ in marks}
    return (
        tuple(
            (attr, False)
            for attr in (VarAttr.INTEGER, VarAttr.LOWER, VarAttr.UPPER)
            if attr not in named
        )
        + marks
    )


async def _aim_reference(
    session: SessionState,
    view: SessionView,
    cmd: str,
    key: str,
    append: bool,
    given: str,
    shaping: AttrMarks,
    marks: AttrMarks,
    creates: bool,
) -> str | None:
    """Aim a ``declare -n NAME=VALUE`` (or ``NAME+=VALUE``) reference
    once the name may take one.

    The reference is what ``+=`` builds onto its own value, and under a
    declared ``-i`` what the arithmetic makes of it, landing the writes
    it does (``M='X=5'; declare -ni r=M`` sets X) and never a name. A
    result that names no variable fails, in bash's words when the given
    text names none either (``declare -n r=''`` is `` `': not a valid
    identifier``) and silently otherwise (``x=1; declare -n x+=T``).
    The name still takes the declaration's marks but ``-n``, ``-i -l
    -u`` it did not ask for coming off, and a local it made stays
    declared; a name that never existed stays unset.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        cmd (str): the builtin's spelling, for diagnostics.
        key (str): the reference being declared.
        append (bool): the operand was ``NAME+=VALUE``.
        given (str): the value as written.
        shaping (AttrMarks): the ``-i -l -u`` / ``+i +l +u`` marks.
        marks (AttrMarks): the attribute marks.
        creates (bool): the declaration made ``key`` a new local.

    Returns:
        The refusal line ("" for a silent one), or None once aimed.

    Raises:
        PolicyDenied: the gate refused a write or a mark.
        ExitSignal: an ``-i`` value assigned a readonly variable,
            which ends the shell.
        ArithError: an ``-i`` value did not evaluate.
    """
    own = visible_record(session, key)
    held = own.value if append and own is not None else None
    old = held if isinstance(held, str) else ""
    value = old + given
    if (VarAttr.INTEGER, True) in shaping:
        await evaluate_integer(
            session, view, appended(old, given, True) if append else given
        )
        value = ""
    if is_valid_name(value) or SUBSCRIPT_RE.fullmatch(value) is not None:
        line = nameref_refusal(cmd, key, value)
        if line is not None:
            return line
        await premark(view, key, shaping, False)
        await view.set(key, value, follow_ref=False)
        await stamp_marks(session, view, key, key, marks, False)
        return None
    if creates and key not in session.vars:
        await view.mark(key, None, True, False)
    if key in session.vars:
        kept = tuple(mark for mark in marks if mark[0] is not VarAttr.NAMEREF)
        await stamp_marks(session, view, key, None, kept, False)
    return (
        ""
        if is_valid_name(given)
        else f"bash: {cmd}: `{given}': not a valid identifier"
    )


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
