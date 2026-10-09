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

import functools
from collections.abc import Awaitable
from typing import Any, Callable

from mirage.cache.index.scope import command_scope
from mirage.io import IOResult
from mirage.policy import PolicyDenied
from mirage.shell.array import (
    ShellArray,
    array_extent,
    array_get,
    array_set,
    array_with,
    build_assoc_literal,
    build_indexed_literal,
)
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, DiscardSignal
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import ShellValue, VarAttr
from mirage.shell.xtrace import trace_assignment
from mirage.types import word_text
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.statement import assignment_status
from mirage.workspace.expand import expand_and_classify, expand_node
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.state import (
    appended,
    conversion_scalar,
    deref,
    session_view,
    subscript_index,
)
from mirage.workspace.types import ExecutionNode


async def _fatal_index(
    context: EvaluationContext, subscript: str, view: SessionView | None
) -> int:
    """``subscript_index`` whose failure ends the line, in bash's words.

    Args:
        context (EvaluationContext): the session the subscript reads.
        subscript (str): the raw subscript text.
        view (SessionView | None): the gated session view.
    """
    session = context.session
    try:
        return await subscript_index(session, subscript, view)
    except ArithError as exc:
        raise exc.signal(fatal=True) from exc


async def _fatal_index_literal(
    held: ShellArray | None,
    items: list[str],
    append: bool,
    index_of: Callable[[str], Awaitable[int]],
) -> ShellArray:
    """``build_indexed_literal`` whose subscript failure ends the line.

    Args:
        held (ShellArray | None): the existing array, for ``+=``.
        items (list[str]): the expanded element words.
        append (bool): extend rather than replace.
        index_of (Callable[[str], Awaitable[int]]): the subscript
            resolver, bound to the session and its view.
    """
    try:
        return await build_indexed_literal(held, items, append, index_of)
    except ArithError as exc:
        raise exc.signal(fatal=True) from exc


def _refuse_readonly(view: SessionView, key: str) -> None:
    """Discard the line on a write to a readonly ``key`` before its new
    value is built: bash refuses an array literal before expanding it,
    and an element write once its value and subscript are read, before
    the array would grow to the index (``a[2**40]=x``). The store refuses
    every other spelling (``_assign_var``).

    Args:
        view (SessionView): the gated session view.
        key (str): the variable being written.
    """
    if view.is_readonly(key, False):
        raise DiscardSignal(encode_text(f"bash: {key}: readonly variable\n"))


async def _assign_var(
    view: SessionView,
    key: str,
    value: ShellValue,
    assigned: frozenset[int | str] | None = None,
    added: str | None = None,
) -> None:
    """One assignment through the session view; denial is fatal.

    Every assignment spelling (scalar, array literal, subscript,
    append) computes its resulting value and stores through
    ``view.set``, so the gate and the storage invariant live in the
    session view, not here. A readonly name or a denial is a fatal
    variable-assignment error that abandons the rest of the line
    (builtins like ``export`` merely fail with 1 and continue).

    Args:
        view (SessionView): the gated session view.
        key (str): the variable being written.
        value (ShellValue): the resulting value to store.
        assigned (frozenset[int | str] | None): the elements written,
            None for the whole value.
        added (str | None): an integer ``+=``'s text (``appended``).
    """
    try:
        await view.set(key, value, assigned=assigned, added=added)
    except PolicyDenied as exc:
        raise DiscardSignal(encode_text(f"{exc.strerror}\n")) from exc
    except ReadonlyVariableError as exc:
        raise DiscardSignal(encode_text(f"{exc}\n")) from exc
    except ArithError as exc:
        raise exc.signal(fatal=True) from exc


async def expand_array_items(
    array_node: Any,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
) -> list[str]:
    """Expand an array literal into its element words.

    Elements behave like any other shell word list: command
    substitutions word-split and globs resolve to matches
    (``a=($(cmd) /data/*.txt)``), with zero-match globs kept literal.

    Args:
        array_node (Any): the tree-sitter ``array`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): workspace execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
    """
    session = context.session
    # The session view, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
    values = list(array_node.named_children)
    # A bare assignment is no command, but its glob reads listings all the
    # same, so it gets a scope of its own.
    async with command_scope():
        classified = await expand_and_classify(
            values, context, execute_fn, registry, session.cwd, cs, view=view
        )
        resolved = await resolve_globs(
            classified,
            registry,
            noglob=bool(session.shell_options.get("noglob")),
            links=namespace,
            options=glob_options(session),
        )
    return [word_text(w) for w in resolved]


_SUBSCRIPT_LITERAL_TYPES = frozenset({NT.WORD, NT.NUMBER, NT.ERROR})


async def _subscript_key_text(
    subscript_node: Any,
    name: str,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    cs: CallStack | None,
    view: SessionView | None,
) -> str:
    """The expanded subscript text of one ``name[...]=`` assignment.

    A purely literal subscript keeps its raw spelling, spaces included
    (bash stores ``m[ k ]`` under the key ``" k "``); anything carrying
    an expansion or quoting expands node by node so ``m[$k]`` and
    ``m["a b"]`` resolve with quote removal. The associative path uses
    the result as the key verbatim; the indexed path evaluates it as
    arithmetic.

    Args:
        subscript_node (Any): the tree-sitter ``subscript`` node.
        name (str): the array variable's name, for the raw slice.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        cs (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view.
    """
    inner = [
        sc
        for sc in subscript_node.named_children
        if sc.type != NT.VARIABLE_NAME
    ]
    raw = get_text(subscript_node)[len(name) + 1 : -1]
    if not inner or all(sc.type in _SUBSCRIPT_LITERAL_TYPES for sc in inner):
        return raw
    parts = []
    for sc in inner:
        parts.append(await expand_node(sc, context, execute_fn, cs, view=view))
    return "".join(parts)


async def execute_assignment(
    node: Any,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute one top-level variable assignment (`a=1`, `a[i]+=v`).

    Every spelling -- scalar, array literal, subscript, append -- is
    computed with bash's own mechanics on a copy of the held value and
    then stored through the session view, which owns the admission gate
    and the scalar/array invariant.

    Args:
        node (Any): the tree-sitter ``variable_assignment`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
    """
    session = context.session
    text = get_text(node)
    if "=" not in text:
        return None, IOResult(), ExecutionNode(command=text, exit_code=0)
    sub_seq = context.frame.cmdsub_seq
    subscript_node = next(
        (c for c in node.named_children if c.type == "subscript"), None
    )
    name_source = subscript_node if subscript_node is not None else node
    name_node = next(
        (c for c in name_source.named_children if c.type == NT.VARIABLE_NAME),
        None,
    )
    spelled = (
        get_text(name_node)
        if name_node is not None
        else text.partition("=")[0]
    )
    # A name reference assigns to its target, whatever the shape of
    # the assignment; an unaimed one (`declare -n r; r=v`) resolves
    # to itself and takes the value as the target's name. The
    # spelling is kept for slicing the subscript out of the source.
    key = deref(session, spelled) or spelled
    append = any(c.type == "+=" for c in node.children)
    # `+=` on an integer adds, element by element too (`appended`).
    held_var = session.vars.get(key)
    integer = held_var is not None and VarAttr.INTEGER in held_var.attrs
    val_nodes = [
        c
        for c in node.named_children
        if c.type not in (NT.VARIABLE_NAME, "subscript")
    ]
    # Every branch below computes its resulting value with bash's
    # own mechanics on a copy, then stores through the one session
    # view, which owns the gate and the scalar/array invariant.
    view = session_view(
        session,
        namespace.registry.policies,
        diagnostics=context.frame.diagnostics,
    )
    # `set -x` traces the name as typed, before the store refuses it.
    xtrace = session.shell_options.get("xtrace")
    if val_nodes and val_nodes[0].type == NT.ARRAY:
        if xtrace:
            # A literal traces as typed, its words one space apart.
            words = " ".join(
                get_text(c)
                for c in val_nodes[0].named_children
                if c.type != NT.COMMENT
            )
            op = "+=" if append else "="
            context.frame.diagnostics.append(
                encode_text(f"+ {spelled}{op}({words})\n")
            )
        _refuse_readonly(view, key)
        items = await expand_array_items(
            val_nodes[0], context, execute_fn, registry, namespace, cs
        )
        amap = session.assocs.get(key)
        if amap is not None:
            built, bad_words = build_assoc_literal(amap, items, append)
            await _assign_var(view, key, built)
            # A plain word in a keyed literal is dropped with a warning
            # and the assignment still succeeds; unlike a declaration's,
            # this voice does not quote the word (pinned on 5.2.37).
            err = encode_text(
                "".join(
                    f"bash: {key}: {word}: must use subscript when "
                    "assigning associative array\n"
                    for word in bad_words
                )
            )
            code = assignment_status(context.frame, sub_seq)
            return (
                None,
                IOResult(exit_code=code, stderr=err or None),
                ExecutionNode(command=text, exit_code=code, stderr=err),
            )
        held = session.arrays.get(key)
        if append and held is None:
            scalar = conversion_scalar(session, key)
            held = None if scalar is None else [scalar]
        # `arr+=(...)` starts at the extent, so it fills the hole a
        # trailing `unset arr[last]` left but skips interior ones;
        # a `[i]=v` element places at i and the next plain word
        # continues from there.
        base = await _fatal_index_literal(
            held,
            items,
            append,
            functools.partial(subscript_index, session, view=view),
        )
        await _assign_var(view, key, base)
        code = assignment_status(context.frame, sub_seq)
        return (
            None,
            IOResult(exit_code=code),
            ExecutionNode(command=text, exit_code=code),
        )
    if val_nodes:
        val = await expand_node(
            val_nodes[0], context, execute_fn, cs, view=view
        )
    else:
        val = text.partition("=")[2]
    if xtrace:
        target = (
            spelled if subscript_node is None else get_text(subscript_node)
        )
        context.frame.diagnostics.append(
            encode_text(trace_assignment(target, val, append) + "\n")
        )
    if subscript_node is not None:
        sub_text = await _subscript_key_text(
            subscript_node, spelled, context, execute_fn, cs, view
        )
        amap = session.assocs.get(key)
        raw_sub = get_text(subscript_node)[len(spelled) + 1 : -1]
        if not raw_sub.strip() or (amap is not None and sub_text == ""):
            # bash discards the rest of the line on a bad assignment
            # subscript (status 1), naming the raw spelling
            # (`m[$e]: bad array subscript`). An indexed subscript
            # that merely *expands* empty stays legal (arithmetic
            # on nothing is 0), so only the associative kind checks
            # the expanded text.
            name_text = text.partition("=")[0].removesuffix("+")
            raise DiscardSignal(
                encode_text(f"bash: {name_text}: bad array subscript\n")
            )
        if amap is not None:
            # The subscript is the key: no arithmetic, `m[1+1]`
            # writes the key "1+1".
            new_map = dict(amap)
            new_map[sub_text], added = (
                appended(amap.get(sub_text, ""), val, integer)
                if append
                else (val, None)
            )
            await _assign_var(view, key, new_map, frozenset({sub_text}), added)
            code = assignment_status(context.frame, sub_seq)
            return (
                None,
                IOResult(exit_code=code),
                ExecutionNode(command=text, exit_code=code),
            )
        arr = session.arrays.get(key)
        if arr is None:
            scalar = conversion_scalar(session, key)
            arr = [] if scalar is None else [scalar]
        idx = await _fatal_index(context, sub_text, view)
        if idx < 0:
            idx += array_extent(arr)
        if idx < 0:
            # Same fatal shape as the empty subscript above.
            name_text = text.partition("=")[0].removesuffix("+")
            raise DiscardSignal(
                encode_text(f"bash: {name_text}: bad array subscript\n")
            )
        _refuse_readonly(view, key)
        slot, added = (
            appended(array_get(arr, idx), val, integer)
            if append
            else (val, None)
        )
        await _assign_var(
            view, key, array_with(arr, idx, slot), frozenset({idx}), added
        )
        code = assignment_status(context.frame, sub_seq)
        return (
            None,
            IOResult(exit_code=code),
            ExecutionNode(command=text, exit_code=code),
        )
    held_map = session.assocs.get(key)
    held_arr = session.arrays.get(key)
    stored, added = val, None
    if append:
        # `a+=x` appends onto element 0 (key "0" of a map); `n+=3` on
        # an integer name adds: `declare -i n=5; n+=3` stores 8.
        if held_map is not None:
            old = held_map.get("0", "")
        elif held_arr is not None:
            old = array_get(held_arr, 0)
        else:
            old = session.env.get(key, "")
        stored, added = appended(old, val, integer)
    if held_map is not None:
        # `m=x` on an associative array writes the literal key "0"
        # and keeps every other key, as bash does.
        new_map = dict(held_map)
        new_map["0"] = stored
        await _assign_var(view, key, new_map, frozenset({"0"}), added)
    elif held_arr is not None:
        # `a=x` writes element 0 and keeps the rest.
        new_arr = list(held_arr)
        array_set(new_arr, 0, stored)
        await _assign_var(view, key, new_arr, frozenset({0}), added)
    else:
        await _assign_var(view, key, stored, added=added)
    # Reassigning OPTIND (even to its current value) restarts the
    # getopts scan, matching bash's internal char pointer.
    if key == "OPTIND":
        session._getopts_optind = None
    code = assignment_status(context.frame, sub_seq)
    return (
        None,
        IOResult(exit_code=code),
        ExecutionNode(command=text, exit_code=code),
    )
