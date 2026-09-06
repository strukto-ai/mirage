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

import re

from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.array import (array_count, array_extent, array_get,
                                array_has, array_with)
from mirage.shell.variable import ShellValue
from mirage.workspace.session.session import Session
from mirage.workspace.session.state import (conversion_scalar, deref,
                                            ensure_var_visible, env_get,
                                            seed_var, strip_key_quotes,
                                            subscript_index, visible_arrays,
                                            visible_assocs)

_ELEMENT_REF = re.compile(r"([A-Za-z_]\w*)(?:\[(.+)\])?\Z", re.DOTALL)


async def element_is_set(session: Session,
                         ref: str,
                         view: SessionView | None = None) -> bool:
    """Whether a ``name`` / ``name[sub]`` reference names a set value.

    What ``test -v`` asks. A bare name over an array checks element 0
    (the literal key ``"0"`` for an associative one), which is GNU's
    rule; ``name[@]`` and ``name[*]`` ask whether any element is set.
    An associative subscript is the key verbatim; an indexed one
    evaluates as arithmetic, and what it assigns lands
    (``[[ -v a[x=2] ]]`` leaves x at 2, as bash does).

    Args:
        session (Session): shell session state.
        ref (str): the reference as the operand spelled it.
        view (SessionView | None): the gated door the subscript's
            assignments land through; None outside a workspace.
    """
    match = _ELEMENT_REF.fullmatch(ref)
    if match is None:
        return False
    name, sub = match.group(1), match.group(2)
    amap = visible_assocs(session).get(name)
    arr = visible_arrays(session).get(name)
    if sub is None:
        if amap is not None:
            return "0" in amap
        if arr is not None:
            return array_has(arr, 0)
        return env_get(session, name) is not None
    if sub in ("@", "*"):
        if amap is not None:
            return len(amap) > 0
        if arr is not None:
            return array_count(arr) > 0
        return env_get(session, name) is not None
    if amap is not None:
        # The subscript arrives as the operand spelled it, so
        # `test -v 'm["x"]'` asks after key `x`, as the resolver reads
        # it in arithmetic and as bash removes the quotes.
        return strip_key_quotes(sub) in amap
    scalar = env_get(session, name)
    held: list[str | None]
    if arr is not None:
        held = arr
    elif scalar is not None:
        held = [scalar]
    else:
        return False
    idx = await subscript_index(session, sub, view)
    if idx < 0:
        idx += array_extent(held)
    return array_has(held, idx)


async def assign_element(session: Session,
                         view: SessionView | None,
                         name: str,
                         subscript: str | None,
                         value: str,
                         append: bool = False) -> str:
    """Assign one element (or a bare name resolved as element 0).

    The element mechanics are computed on a copy and the landing write
    goes through the door as the whole variable the write produces, so
    a refused write leaves nothing half-applied and a ``pre_session``
    rule sees ``m[k]=v`` as a write to ``m``. The subscript arrives
    already expanded: an associative name takes it as the key verbatim,
    an indexed one evaluates it as arithmetic.

    Args:
        session (Session): shell session state.
        view (SessionView | None): the session plane's gated door;
            None seeds directly (a writer outside a workspace).
        name (str): the target's base variable name.
        subscript (str | None): the ``[...]`` text, or None for a bare
            target, which bash resolves as element 0 of an array and a
            plain scalar otherwise.
        value (str): the text to store.
        append (bool): concatenate onto the existing element.

    Returns:
        str: ``"ok"``, ``"denied"``, ``"readonly"``, or ``"subscript"``.

    Raises:
        PolicyDenied: a pre_session rule refused the write; the caller
            renders the rule's own message.
        ArithError: the name carries ``-i`` and the text does not
            evaluate; the caller voices it after the offending text.
    """
    # An element write through a name reference lands on the target,
    # so it is resolved once here and the raw storage reads below all
    # look at the variable the write will produce.
    name = deref(session, name) or name
    try:
        ensure_var_visible(session, name)
    except PolicyDenied:
        return "denied"
    if name in session.readonly_vars:
        return "readonly"
    amap = session.assocs.get(name)
    stored: ShellValue
    if amap is not None:
        key = "0" if subscript is None else subscript
        if key == "":
            return "subscript"
        updated = dict(amap)
        updated[key] = (amap.get(key, "") + value) if append else value
        stored = updated
    else:
        arr = session.arrays.get(name)
        if subscript is None and arr is None:
            stored = (session.env.get(name, "") + value) if append else value
        else:
            if arr is None:
                scalar = conversion_scalar(session, name)
                # An existing scalar becomes element 0, even when
                # empty: bash resolves `x[-1]` against the length-1
                # array that produces.
                arr = [] if scalar is None else [scalar]
            idx = (0 if subscript is None else await subscript_index(
                session, subscript, view))
            if idx < 0:
                idx += array_extent(arr)
            if idx < 0:
                return "subscript"
            base = array_get(arr, idx) if append else ""
            stored = array_with(arr, idx, base + value)
    if view is not None:
        await view.set(name, stored)
        return "ok"
    seed_var(session, name, stored)
    return "ok"
