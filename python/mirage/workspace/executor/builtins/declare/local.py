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
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.declare.declare import (
    identifier_failure, identifier_refusal, nameref_refusal, premark,
    store_staged_arrays, write_global)
from mirage.workspace.executor.builtins.shared import (arith_refusal,
                                                       readonly_refusal,
                                                       refusal, require_view)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import Session
from mirage.workspace.session.state import (env_get, session_view,
                                            shadow_local, visible_arrays,
                                            visible_assocs)
from mirage.workspace.types import ExecutionNode


async def handle_local(
    assignments: list[str],
    session: Session,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
    cmd: str = "local",
    stored: list[str] | None = None,
    assoc: bool = False,
    shaping: frozenset[VarAttr] = frozenset(),
    nameref: bool = False,
    global_scope: bool = False,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Declare names in the running function's scope, or globally.

    Args:
        assignments (list[str]): ``NAME`` / ``NAME=value`` operands.
        session (Session): shell session state.
        state (SessionView | None): the session plane's gated door.
        arrays (list[tuple[str, bool, list[str]]] | None): staged array
            literals from the declaration.
        cmd (str): the spelling that reached here, for diagnostics.
            ``declare`` and ``typeset`` route through this handler and
            must say their own name, not ``local``.
        stored (list[str] | None): filled with each name that stored.
        assoc (bool): the declaration carried ``-A``, so staged
            literals build associative maps.
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
    """
    local_vars = None if global_scope else session._local_vars
    if cmd == "local" and session._local_vars is None:
        # `local` is the one spelling that needs a function scope;
        # `declare`/`typeset` share this handler and are legal at top
        # level. Without the check the builtin took its operands, stored
        # them globally and exited 0, which is the silent-accept this
        # whole tier exists to remove.
        err = b"bash: local: can only be used in a function\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd,
                                                         exit_code=1,
                                                         stderr=err)
    view = require_view(state)
    errors: list[str] = []
    if arrays:
        refused = await store_staged_arrays(cmd,
                                            session,
                                            view,
                                            arrays,
                                            fatal=session._local_vars is None,
                                            stored=stored,
                                            assoc=assoc,
                                            errors=errors,
                                            shaping=shaping,
                                            global_scope=global_scope)
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
            if local_vars is not None:
                shadow_local(session, local_vars, key)
            try:
                await premark(view, key, shaping)
                if global_scope:
                    await write_global(session, view, key, val)
                else:
                    await view.set(key, val, follow_ref=not nameref)
            except PolicyDenied as exc:
                return refusal(cmd, exc)
            except ArithError as exc:
                return arith_refusal(cmd, exc)
            if stored is not None:
                stored.append(key)
        else:
            if local_vars is not None:
                shadow_local(session, local_vars, assign)
            if (env_get(session, assign) is None
                    and assign not in visible_arrays(session)
                    and assign not in visible_assocs(session)):
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


async def local_builtin(call: BuiltinCall) -> Result:
    """The ``local`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_local(
        list(call.argv.args), call.session,
        session_view(call.session, call.namespace.registry.policies))
