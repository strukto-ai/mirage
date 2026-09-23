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
from mirage.workspace.executor.builtins.declare.constants import (
    READONLY_FLAGS, READONLY_USAGE)
from mirage.workspace.executor.builtins.declare.declare import (
    assoc_body, bash_declare_quote, identifier_failure, identifier_refusal,
    premark, readonly_functions, split_decl_flags, store_staged_arrays)
from mirage.workspace.executor.builtins.shared import (arith_refusal,
                                                       readonly_refusal,
                                                       refusal, require_view)
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (env_is_readonly, set_attr,
                                            visible_env)
from mirage.workspace.types import ExecutionNode


def _readonly_lines(session: SessionState, flags: set[str]) -> list[str]:
    """Build sorted ``declare -r`` family readonly lines.

    ``-a`` narrows the listing to indexed arrays and ``-A`` to
    associative ones, the way bash does. ``-f`` selects functions,
    which mirage carries no readonly attribute for, so that form lists
    nothing. Bare and ``-p`` list every readonly name.

    Args:
        session (SessionState): shell session state.
        flags (set[str]): option letters the caller supplied.

    Returns:
        list[str]: one declaration line per selected name.
    """
    if "f" in flags:
        return []
    arrays_only = "a" in flags
    assocs_only = "A" in flags
    env = visible_env(session)
    lines: list[str] = []
    # env_is_readonly answers False for a hidden name, so a hidden
    # readonly never prints even its bare `declare -r NAME` row.
    for name in sorted(n for n in session.readonly_vars
                       if env_is_readonly(session, n)):
        arr = session.arrays.get(name)
        amap = session.assocs.get(name)
        if arr is not None and not assocs_only:
            parts = [
                f"[{i}]={bash_declare_quote(v)}" for i, v in enumerate(arr)
                if v is not None
            ]
            lines.append(f"declare -ar {name}=({' '.join(parts)})")
            continue
        if amap is not None and not arrays_only:
            lines.append(f"declare -Ar {name}{assoc_body(amap)}")
            continue
        if arrays_only or assocs_only or arr is not None or amap is not None:
            continue
        if name in env:
            lines.append(f"declare -r {name}={bash_declare_quote(env[name])}")
        else:
            lines.append(f"declare -r {name}")
    return lines


async def handle_readonly(
    assignments: list[str],
    session: SessionState,
    state: SessionView | None = None,
    arrays: list[tuple[str, bool, list[str]]] | None = None,
    stored: list[str] | None = None,
    assoc: bool = False,
    shaping: frozenset[VarAttr] = frozenset(),
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Mark names readonly, or print them (``readonly -p`` / bare form).

    With no name operands, prints every readonly name as ``declare -r``
    (or ``declare -ar`` for arrays). Invalid options fail with status 2.

    ``-f`` freezes *functions*: a frozen one refuses redefinition and
    ``unset -f`` with its own message, exit 1, and the old body stays.
    A name that is not a function is ``not a function``, exit 1, and
    the other operands still freeze. With no names, ``-f`` lists the
    frozen functions as ``declare -fr NAME``; GNU prints each body first
    through its own pretty-printer, which mirage does not carry, so the
    body line is the one deliberate omission.
    """
    flags, names, bad = split_decl_flags(assignments, READONLY_FLAGS)
    if bad is not None:
        err = (f"bash: readonly: -{bad}: invalid option\n"
               f"{READONLY_USAGE}").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="readonly",
                                                         exit_code=2,
                                                         stderr=err)
    if "f" in flags:
        return readonly_functions(session, names)
    if not names and not arrays:
        lines = _readonly_lines(session, flags)
        out = (("\n".join(lines) + "\n") if lines else "").encode()
        return out, IOResult(), ExecutionNode(command="readonly", exit_code=0)
    view = require_view(state)
    errors: list[str] = []
    if arrays:
        refused = await store_staged_arrays("readonly",
                                            session,
                                            view,
                                            arrays,
                                            mark=VarAttr.READONLY,
                                            fatal=True,
                                            stored=stored,
                                            assoc=assoc or "A" in flags,
                                            errors=errors,
                                            shaping=shaping)
        if refused is not None:
            return refused
    for assign in names:
        bad_name = identifier_refusal("readonly", assign)
        if bad_name is not None:
            errors.append(bad_name)
            continue
        if "=" in assign:
            key, _, val = assign.partition("=")
            if view.is_readonly(key):
                return readonly_refusal("readonly", key)
            try:
                await premark(view, key, shaping)
                await view.set(key, val)
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
                await view.mark(assign, VarAttr.READONLY, True)
            except PolicyDenied as exc:
                return refusal("readonly", exc)
            if stored is not None:
                stored.append(assign)
    if errors:
        return identifier_failure("readonly", errors)
    return None, IOResult(), ExecutionNode(command="readonly", exit_code=0)
