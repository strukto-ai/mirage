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
from mirage.shell.variable import VarAttr, VarKind
from mirage.workspace.executor.builtins.declare.declare import (
    held_value,
    identifier_failure,
    identifier_refusal,
    kind_conflict,
    local_attrs,
    nameref_refusal,
    premark,
    scalar_value,
    start_local,
    store_staged_arrays,
    write_global,
)
from mirage.workspace.executor.builtins.shared import (
    arith_refusal,
    readonly_refusal,
    refusal,
    require_view,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
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
    stored: list[str] | None = None,
    kind: VarKind | None = None,
    shaping: frozenset[VarAttr] = frozenset(),
    nameref: bool = False,
    global_scope: bool = False,
    inherit: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Declare names in the running function's scope, or globally.

    Args:
        assignments (list[str]): ``NAME`` / ``NAME=value`` operands.
        session (SessionState): shell session state.
        state (SessionView | None): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the declaration.
        cmd (str): the spelling that reached here, for diagnostics.
            ``declare`` and ``typeset`` route through this handler and
            must say their own name, not ``local``.
        stored (list[str] | None): filled with each name that stored.
        kind (VarKind | None): the kind ``-a`` / ``-A`` declared, so
            staged literals build that kind of array.
        shaping (frozenset[VarAttr]): the value-shaping attributes
            (``-i -l -u``) the declaration carries. They are marked on
            each name *before* its value stores, after the local
            snapshot, so the declaration's own value coerces exactly as
            a later write would: GNU stores ``7`` for
            ``declare -i n=3+4`` and ``hello`` for ``declare -l s=HeLLo``.
        nameref (bool): the declaration carried ``-n``, so a value names
            the reference's target and is stored on the reference's own
            record rather than written through an existing one.
        global_scope (bool): the declaration carried ``-g``, so inside a
            function the names are declared globally: no local snapshot
            is taken, and a name the function already shadows has its
            *global* record written.
        inherit (bool): the declaration carried ``-I``, so a new local
            keeps the shadowed variable's value and attributes but a
            reference (``local_attrs``).
    """
    local_vars = None if global_scope else session._local_vars
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
    errors: list[str] = []
    if arrays:
        refused = await store_staged_arrays(
            cmd,
            session,
            view,
            arrays,
            fatal=session._local_vars is None,
            stored=stored,
            kind=kind,
            errors=errors,
            shaping=shaping,
            global_scope=global_scope,
        )
        if refused is not None:
            return refused
    for assign in assignments:
        bad_name = identifier_refusal(cmd, assign)
        if bad_name is not None:
            errors.append(bad_name)
            continue
        if "=" in assign:
            key, _, val = assign.partition("=")
            if nameref:
                bad_ref = nameref_refusal(cmd, key, val)
                if bad_ref is not None:
                    errors.append(bad_ref)
                    continue
            if view.is_readonly(key):
                return readonly_refusal(cmd, key)
            # A new local holds nothing of the caller's; otherwise the
            # value lands as any declaration's does (`scalar_value`), and
            # an array kind the variable cannot take is refused.
            fresh = local_vars is not None and key not in local_vars
            held = (
                None
                if fresh or nameref
                else held_value(session, key, global_scope)
            )
            conflict = kind_conflict(held, kind)
            if conflict is not None:
                errors.append(f"bash: {cmd}: {key}: {conflict}")
                continue
            if local_vars is not None:
                shadow_local(session, local_vars, key)
            if fresh and not in_call_env(session, key):
                start_local(session, key, inherit)
            value, assigned = (
                (val, None) if nameref else scalar_value(held, val, kind)
            )
            try:
                await premark(view, key, shaping)
                if global_scope:
                    await write_global(session, view, key, value, assigned)
                else:
                    await view.set(
                        key, value, follow_ref=not nameref, assigned=assigned
                    )
            except PolicyDenied as exc:
                return refusal(cmd, exc)
            except ArithError as exc:
                return arith_refusal(cmd, exc)
            if stored is not None:
                stored.append(key)
        else:
            if local_vars is not None:
                fresh = assign not in local_vars
                shadow_local(session, local_vars, assign)
                refused = (
                    await _fresh_local(session, view, cmd, assign, inherit)
                    if fresh
                    else None
                )
                if refused is not None:
                    return refused
            if (
                env_get(session, assign) is None
                and assign not in visible_arrays(session)
                and assign not in visible_assocs(session)
            ):
                # A bare declaration of an existing array re-scopes it;
                # a scalar write here would erase it. Visible reads: a
                # hidden name counts as unset, so the write is
                # attempted and the door refuses it.
                if view.is_readonly(assign):
                    return readonly_refusal(cmd, assign)
                try:
                    # Declared, not assigned. `local L` leaves the name
                    # *unset*, exactly as `export Z` does: GNU prints
                    # `declare -- L` and `${L-d}` still expands to `d`.
                    # Writing `""` here made both wrong, which is the
                    # same invented-empty-string bug the mark door was
                    # added to fix for `export`.
                    await view.mark(assign, None, True)
                except PolicyDenied as exc:
                    return refusal(cmd, exc)
            if stored is not None:
                stored.append(assign)
    if errors:
        return identifier_failure(cmd, errors)
    return None, IOResult(), ExecutionNode(command=cmd, exit_code=0)


async def _fresh_local(
    session: SessionState,
    view: SessionView,
    cmd: str,
    name: str,
    inherit: bool = False,
) -> Result | None:
    """Start a new ``local NAME`` unset, as bash 5.2 does.

    Only a name the frame did not shadow yet: a second ``local x``, or
    the fresh array ``local -a x`` has already put in place, keeps what
    the function holds.

    The caller's value and attributes stay behind except the export
    mark: GNU prints ``declare -- x`` for ``x=1; f() { local x; }`` and
    ``declare -x x`` for an exported one, and ``local x; x+=y`` stores
    ``y`` (``local_attrs``). With ``-I`` the value and attributes stay,
    a reference's aside. A name the call assigned in front is the
    exception and keeps that value (``x=1 f`` where f runs ``local x``
    reads 1). A readonly name refuses, as GNU's does.

    Args:
        session (SessionState): shell session state.
        view (SessionView): the session plane's gated door.
        cmd (str): the builtin's spelling, for the diagnostic.
        name (str): the name being declared.
        inherit (bool): the declaration carried ``-I``.

    Returns:
        A refusal result, else None.
    """
    var = session.vars.get(name)
    if var is None or in_call_env(session, name):
        return None
    if view.is_readonly(name):
        return readonly_refusal(cmd, name)
    try:
        if inherit:
            if VarAttr.NAMEREF in var.attrs:
                await view.mark(name, VarAttr.NAMEREF, False)
        else:
            await view.unset(name, follow_ref=False)
            for attr in local_attrs(var, inherit):
                await view.mark(name, attr, True)
    except PolicyDenied as exc:
        return refusal(cmd, exc)
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
