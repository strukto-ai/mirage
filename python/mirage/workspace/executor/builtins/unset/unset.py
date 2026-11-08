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

from mirage.policy import PolicyDenied
from mirage.policy.policies import Policies
from mirage.shell.constants import BASH_LINENO, FUNCNAME
from mirage.shell.errors import ArithError
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.constants import TARGET_RE
from mirage.workspace.executor.builtins.help import flag_help
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    fail,
    finish,
    identifier_line,
    require_view,
    subscript_expansion,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.expand.types import SubscriptFn
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    deref,
    session_view,
    unset_element,
)


def _unset_variable(session: SessionState, name: str) -> None:
    """Clear the getopts residue after a whole-variable unset.

    The record itself is the view's to drop, scalar or array alike: it
    keeps a hidden name, and inside a function it may put back a value
    an enclosing scope saved.

    Args:
        session (SessionState): shell session state.
        name (str): a bare variable name (no subscript).
    """
    if name == "OPTIND":
        session._getopts_optind = None
    if name == FUNCNAME:
        session.function_names = None


async def _unset_one(
    session: SessionState,
    base: str,
    subscript: str,
    policies: Policies | None = None,
) -> str:
    """Clear one array element, or a scalar addressed as ``base[0]``, as
    one gated write, so a denial leaves the array untouched.

    Clearing an element keeps the indices of the elements after it, as
    bash does: it leaves a hole, which neither expands in ``${arr[@]}``
    nor counts toward ``${#arr[@]}`` but keeps ``${arr[i]}`` addressing
    the same values. A subscript on a scalar names element 0 only, and a
    subscript on a name that holds nothing at all, or a hidden one, is a
    silent no-op. A subscript that does not evaluate ends the line, in
    bash's words: ``unset 'a[1/0]'`` aborts with ``1/0: division by 0``.

    Args:
        session (SessionState): shell session state.
        base (str): the variable name without the subscript.
        subscript (str): the subscript text between the brackets.
        policies (Policies | None): the policies the write and the
            subscript's assignments clear.

    Returns:
        str: ``"ok"``, ``"notarray"`` when a non-zero subscript was
            applied to a scalar, or ``"subscript"`` for a negative
            subscript outside an existing array.

    Raises:
        PolicyDenied: a pre_session policy refused the write.
    """
    try:
        return await unset_element(session, policies, base, subscript)
    except ArithError as exc:
        raise exc.signal(fatal=True) from exc


def _readonly(name: str, kind: str) -> str:
    """bash's refusal to unset a readonly variable or function.

    Args:
        name (str): the name the refusal reports.
        kind (str): ``variable`` or ``function``.
    """
    return f"{shell_voice()}unset: {name}: cannot unset: readonly {kind}\n"


async def handle_unset(
    args: list[str],
    session: SessionState,
    state: SessionView | None = None,
    policies: Policies | None = None,
    subscripts: SubscriptFn | None = None,
) -> Result:
    """Unset shell variables, arrays, or functions, with bash's flags.

    ``-v`` targets a variable only, and refuses a word that names none;
    ``-f`` a function only, never with ``-v``; and a bare name a
    variable if one exists or else a function. A ``name[idx]``
    operand clears one element; the readonly guard resolves it to the
    base name first, since that is what ``readonly`` records. ``-n``
    unsets a name reference itself, where a bare name unsets what the
    reference points at. A name it cannot unset is reported and the rest
    still go, for status 1.

    Args:
        args (list[str]): option words followed by names to unset.
        session (SessionState): shell session state.
        policies (Policies | None): the policies an indexed subscript's
            assignments clear.
        subscripts (SubscriptFn | None): expands an operand's subscript,
            which bash expands as one typed in ``${a[...]}``; None keeps
            it as typed.
    """
    if args[:1] == ["--help"]:
        answered = flag_help("unset")
        if answered is not None:
            return answered
    letters: set[str] = set()
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if all(ch in "vfn" for ch in tok[1:]):
            letters.update(tok[1:])
            i += 1
            continue
        return fail(
            "unset",
            f"{shell_voice()}unset: {tok}: invalid option\n"
            + builtin_usage("unset"),
            2,
        )
    if {"f", "v"} <= letters:
        return fail(
            "unset",
            f"{shell_voice()}unset: cannot simultaneously unset a function"
            " and a variable\n",
        )
    mode = next((m for m in "fnv" if m in letters), "auto")
    errors: list[str] = []
    for name in args[i:]:
        view = require_view(state)
        if "v" in letters and TARGET_RE.match(name) is None:
            # Only a variable must be named as one: without -v bash falls
            # back to the function table, which takes any name.
            errors.append(identifier_line("unset", name) + "\n")
            continue
        if mode == "n":
            # `unset -n` drops the reference itself rather than what it
            # points at; on a name that is not a reference bash unsets
            # the variable, and both are one ungated-by-target unset. A
            # frozen reference refuses, writable target or not.
            if view.is_readonly(name, False):
                errors.append(_readonly(name, "variable"))
                continue
            if name == BASH_LINENO:
                errors.append(f"{shell_voice()}unset: {name}: cannot unset\n")
                continue
            try:
                await view.unset(name, follow_ref=False)
            except PolicyDenied as exc:
                errors.append(f"{exc.strerror}\n")
            continue
        if mode == "f":
            if name in session.readonly_functions:
                errors.append(_readonly(name, "function"))
                continue
            session.remove_function(name)
            continue
        target = TARGET_RE.match(name)
        subscript = target.group(2) if target is not None else None
        is_element = subscript is not None
        # `readonly arr` records the base name, so an `arr[i]` operand has
        # to be resolved before the guard, as bash does, and a reference
        # to the variable it reaches: bash names that variable, not the
        # element or the reference, in the error.
        base = target.group(1) if target is not None else name
        if view.is_readonly(base):
            errors.append(_readonly(deref(session, base), "variable"))
            continue
        if not is_element and deref(session, base) == BASH_LINENO:
            errors.append(f"{shell_voice()}unset: {name}: cannot unset\n")
            continue
        existed = (
            is_element
            or name in session.env
            or name in session.arrays
            or name in session.assocs
        )
        # Both spellings clear the pre_session gate for the base name:
        # the whole-variable unset through the view's env half, an
        # element unset inside _unset_one, so `unset 'X[0]'` cannot
        # sidestep a policy that vetoes `unset X`.
        try:
            if subscript is not None:
                if subscripts is not None:
                    subscript = await subscripts(subscript)
                status = await _unset_one(session, base, subscript, policies)
            else:
                await view.unset(name)
                _unset_variable(session, deref(session, name))
                status = "ok"
        except PolicyDenied as exc:
            errors.append(f"{exc.strerror}\n")
            continue
        if status != "ok":
            # bash names the base for "not an array variable" but prints
            # only the bracketed part for a bad subscript.
            detail = (
                f"unset: {base}: not an array variable"
                if status == "notarray"
                else f"unset: {name[len(base) :]}: bad array subscript"
            )
            errors.append(f"{shell_voice()}{detail}\n")
            continue
        if mode == "auto" and not existed and name in session.functions:
            if name in session.readonly_functions:
                errors.append(_readonly(name, "function"))
                continue
            session.remove_function(name)
    return finish("unset", errors)


async def unset_builtin(call: BuiltinCall) -> Result:
    """The ``unset`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_unset(
        list(call.argv.args),
        call.context.session,
        session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
        call.namespace.registry.policies,
        subscript_expansion(call),
    )
