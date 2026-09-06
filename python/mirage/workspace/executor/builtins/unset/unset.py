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
from mirage.shell.array import array_extent, array_unset
from mirage.shell.errors import ArithError, ExitSignal
from mirage.utils.hidden import var_hidden
from mirage.workspace.executor.builtins.constants import TARGET_RE
from mirage.workspace.executor.builtins.shared import refusal, require_view
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import Session
from mirage.workspace.session.state import (deref, env_get, session_view,
                                            subscript_index, visible_arrays,
                                            visible_assocs)
from mirage.workspace.types import ExecutionNode


def _unset_variable(session: Session, name: str) -> None:
    """Clear what the env door does not own after a whole-variable unset.

    The scalar half is the view's (``unset`` popped it, or quietly kept
    it for a hidden name — a direct pop here would undo that refusal);
    this clears the array storage and the getopts residue. The array
    pop keeps a hidden name too: the embedder can seed
    ``session.arrays`` before narrowing, so a hidden array exists and
    is as much the host's to keep as the scalar the view protected.

    Args:
        session (Session): shell session state.
        name (str): a bare variable name (no subscript).
    """
    if not var_hidden(session.hidden_vars, name):
        session.vars.pop(name, None)
    if name == "OPTIND":
        session._getopts_optind = None


async def _fatal_index(session: Session, subscript: str,
                       view: SessionView) -> int:
    """``subscript_index`` whose failure ends the line, in bash's words:
    ``unset 'a[1/0]'`` aborts with ``1/0: division by 0``.

    Args:
        session (Session): the session the subscript reads.
        subscript (str): the raw subscript text.
        view (SessionView): the gated door.
    """
    try:
        return await subscript_index(session, subscript, view)
    except ArithError as exc:
        raise ExitSignal(1, stderr=f"bash: {exc}\n".encode(),
                         contained_code=1) from exc


async def _unset_element(session: Session, view: SessionView, base: str,
                         subscript: str) -> str:
    """Clear one array element, or a scalar addressed as ``base[0]``.

    Clearing an element keeps the indices of the elements after it, as
    bash does: it leaves a hole, which neither expands in ``${arr[@]}``
    nor counts toward ``${#arr[@]}`` but keeps ``${arr[i]}`` addressing
    the same values. A subscript on a scalar names element 0 only:
    ``x[0]`` unsets the scalar and any other subscript is an error. A
    subscript on a name that holds nothing at all is a silent no-op,
    but on an existing array a negative subscript still below zero
    after the extent is added is a bad-subscript error.

    The element mechanics are the builtin's own, but the landing write
    goes through the door: a scalar's element 0 is the whole unset,
    and an array's hole punch is computed on a copy and stored with
    ``view.set``, so a denial leaves the array untouched. Validation
    errors write nothing and so never ask.

    Args:
        session (Session): shell session state.
        view (SessionView): the session plane's gated door.
        base (str): the variable name without the subscript.
        subscript (str): the subscript text between the brackets.

    Returns:
        str: ``"ok"``, ``"notarray"`` when a non-zero subscript was
            applied to a scalar, or ``"subscript"`` for a negative
            subscript outside an existing array.

    Raises:
        PolicyDenied: a pre_session policy refused the write.
    """
    amap = visible_assocs(session).get(base)
    if amap is not None:
        # The subscript is the key, verbatim: `unset "m[1+1]"` removes
        # the key "1+1", and a key that is not there (GNU pins
        # `unset "m[@]"` on an associative array as this same no-op)
        # answers quietly without a write.
        if subscript not in amap:
            return "ok"
        new_map = dict(amap)
        new_map.pop(subscript)
        await view.set(base, new_map)
        return "ok"
    arr = visible_arrays(session).get(base)
    if arr is None:
        # Visible reads on purpose: a hidden base answers the unset
        # branch's silent no-op instead of a denial that would leak
        # the name's existence.
        if env_get(session, base) is None:
            return "ok"
        if await _fatal_index(session, subscript, view) != 0:
            return "notarray"
        await view.unset(base)
        return "ok"
    idx = await _fatal_index(session, subscript, view)
    if idx < 0:
        idx += array_extent(arr)
        if idx < 0:
            return "subscript"
    new_arr = list(arr)
    array_unset(new_arr, idx)
    await view.set(base, new_arr)
    return "ok"


async def handle_unset(
    args: list[str],
    session: Session,
    state: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Unset shell variables, arrays, or functions, with bash's flags.

    ``-v`` targets a variable only, ``-f`` a function only, and a bare
    name a variable if one exists or else a function. A ``name[idx]``
    operand clears one element; the readonly guard resolves it to the
    base name first, since that is what ``readonly`` records. ``-n``
    unsets a name reference itself, where a bare name unsets what the
    reference points at.

    Args:
        args (list[str]): option words followed by names to unset.
        session (Session): shell session state.
    """
    mode = "auto"
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if all(ch in "vfn" for ch in tok[1:]):
            if "f" in tok[1:]:
                mode = "f"
            elif "n" in tok[1:]:
                mode = "n"
            else:
                mode = "v"
            i += 1
            continue
        err = f"bash: unset: {tok}: invalid option\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="unset",
                                                         exit_code=2,
                                                         stderr=err)
    for name in args[i:]:
        if mode == "n":
            # `unset -n` drops the reference itself rather than what it
            # points at; on a name that is not a reference bash unsets
            # the variable, and both are one ungated-by-target unset.
            try:
                await require_view(state).unset(name, follow_ref=False)
            except PolicyDenied as exc:
                return refusal("unset", exc)
            continue
        if mode == "f":
            if name in session.readonly_functions:
                err = (f"bash: unset: {name}: cannot unset: "
                       "readonly function\n").encode()
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="unset", exit_code=1, stderr=err)
            session.functions.pop(name, None)
            continue
        target = TARGET_RE.match(name)
        subscript = target.group(2) if target is not None else None
        is_element = subscript is not None
        # `readonly arr` records the base name, so an `arr[i]` operand has
        # to be resolved before the guard, as bash does (which also names
        # the base, not the element, in the error).
        base = target.group(1) if target is not None else name
        if base in session.readonly_vars:
            err = (f"bash: unset: {base}: cannot unset: "
                   f"readonly variable\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        existed = (is_element or name in session.env or name in session.arrays
                   or name in session.assocs)
        # Both spellings clear the pre_session gate for the base name:
        # the whole-variable unset through the view's env half, an
        # element unset inside _unset_element, so `unset 'X[0]'` cannot
        # sidestep a policy that vetoes `unset X`.
        try:
            if subscript is not None:
                status = await _unset_element(session, require_view(state),
                                              base, subscript)
            else:
                await require_view(state).unset(name)
                _unset_variable(session, deref(session, name))
                status = "ok"
        except PolicyDenied as exc:
            return refusal("unset", exc)
        if status != "ok":
            # bash names the base for "not an array variable" but prints
            # only the bracketed part for a bad subscript.
            detail = (f"unset: {base}: not an array variable"
                      if status == "notarray" else
                      f"unset: {name[len(base):]}: bad array subscript")
            err = f"bash: {detail}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="unset",
                                                             exit_code=1,
                                                             stderr=err)
        if mode == "auto" and not existed and name in session.functions:
            if name in session.readonly_functions:
                err = (f"bash: unset: {name}: cannot unset: "
                       "readonly function\n").encode()
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="unset", exit_code=1, stderr=err)
            session.functions.pop(name, None)
    return None, IOResult(), ExecutionNode(command="unset", exit_code=0)


async def unset_builtin(call: BuiltinCall) -> Result:
    """The ``unset`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_unset(
        list(call.argv.args), call.session,
        session_view(call.session, call.namespace.registry.policies))
