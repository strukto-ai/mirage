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
from mirage.policy import PolicyDenied
from mirage.policy.policies import Policies
from mirage.shell.array import (
    ShellArray,
    build_assoc_literal,
    build_indexed_literal,
    keyed_word,
    make_array,
)
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import (
    ArithError,
    DiscardSignal,
    ReadonlyVariableError,
)
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import ShellValue
from mirage.shell.voice import shell_voice
from mirage.shell.xtrace import trace_assignment
from mirage.types import word_text
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.shared import ok, result
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.executor.statement import assignment_status
from mirage.workspace.expand import (
    expand_and_classify,
    expand_assignment,
    expand_node,
)
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session.state import (
    assign_element,
    conversion_scalar,
    deref,
    push_words,
    session_view,
    subscript_index,
    var_kind,
)


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
            resolver, bound to the session and its policies.
    """
    try:
        return await build_indexed_literal(held, items, append, index_of)
    except ArithError as exc:
        raise exc.signal(fatal=True) from exc


def _refuse_readonly(view: SessionView, key: str) -> None:
    """Discard the line on a literal written to a readonly ``key``
    before it is expanded, as bash refuses it. The store refuses every
    other spelling once its value and subscript are read, before the
    array would grow to the index (``a[2**40]=x``).

    Args:
        view (SessionView): the gated session view.
        key (str): the variable being written.
    """
    if view.is_readonly(key, False):
        raise DiscardSignal(
            encode_text(f"{shell_voice()}{key}: readonly variable\n")
        )


def _bad_subscript(subscript_node: Any) -> DiscardSignal:
    """bash's refusal of an assignment subscript, naming its raw
    spelling (``m[$e]: bad array subscript``).

    Args:
        subscript_node (Any): the ``subscript`` node.
    """
    return DiscardSignal(
        encode_text(
            f"{shell_voice()}{get_text(subscript_node)}: bad array subscript\n"
        )
    )


async def _landed(write: Awaitable[str | None]) -> str | None:
    """One assignment's write, whose refusal is fatal: a readonly name
    or a denial abandons the rest of the line (builtins like ``export``
    merely fail with 1 and continue), and an arithmetic error in a
    subscript or an ``-i`` value ends the shell.

    Args:
        write (Awaitable[str | None]): the gated write, and the status
            an element write comes to.
    """
    try:
        return await write
    except PolicyDenied as exc:
        raise DiscardSignal(encode_text(f"{exc.strerror}\n")) from exc
    except ReadonlyVariableError as exc:
        raise DiscardSignal(encode_text(f"{shell_voice()}{exc}\n")) from exc
    except ArithError as exc:
        raise exc.signal(fatal=True) from exc


async def _assign_var(view: SessionView, key: str, value: ShellValue) -> None:
    """One whole value through the session view; denial is fatal.

    Args:
        view (SessionView): the gated session view.
        key (str): the variable being written.
        value (ShellValue): the resulting value to store.
    """
    await _landed(view.set(key, value))


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
        array_node (Any): the ``array`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): workspace execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
    """
    session = context.session
    values = list(array_node.named_children)
    # A bare assignment is no command, but its glob reads listings all the
    # same, so it gets a scope of its own.
    async with command_scope():
        classified = await expand_and_classify(
            values,
            context,
            execute_fn,
            registry,
            session.cwd,
            cs,
            registry.policies,
        )
        resolved = await resolve_globs(
            classified,
            registry,
            noglob=bool(session.shell_options.get("noglob")),
            links=namespace.session_links(session),
            options=glob_options(session),
        )
    return [word_text(w) for w in resolved]


_SUBSCRIPT_LITERAL_TYPES = frozenset({NT.WORD, NT.NUMBER})


async def _subscript_key_text(
    subscript_node: Any,
    name: str,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    cs: CallStack | None,
    policies: Policies | None,
) -> str:
    """The expanded subscript text of one ``name[...]=`` assignment.

    A purely literal subscript keeps its raw spelling, spaces included
    (bash stores ``m[ k ]`` under the key ``" k "``); anything carrying
    an expansion or quoting expands node by node so ``m[$k]`` and
    ``m["a b"]`` resolve with quote removal. The associative path uses
    the result as the key verbatim; the indexed path evaluates it as
    arithmetic.

    Args:
        subscript_node (Any): the ``subscript`` node.
        name (str): the array variable's name, for the raw slice.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        cs (CallStack | None): shell call stack.
        policies (Policies | None): the policies its writes clear.
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
        parts.append(await expand_node(sc, context, execute_fn, cs, policies))
    return "".join(parts)


async def execute_assignment(
    node: Any,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
) -> Result:
    """Execute one top-level variable assignment (`a=1`, `a[i]+=v`).

    A literal is built with bash's own mechanics and stored whole
    through the session view, but ``a+=(x y)`` onto an indexed array
    appends in the store. Every other spelling (scalar, subscript,
    append) is one element write the store makes in place, so an
    assignment costs its element, not the array; the view owns the
    admission gate and the scalar/array invariant either way.

    Args:
        node (Any): the ``variable_assignment`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
    """
    session = context.session
    text = get_text(node)
    if "=" not in text:
        return ok(text)
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
    val_nodes = [
        c
        for c in node.named_children
        if c.type not in (NT.VARIABLE_NAME, "subscript")
    ]
    policies = namespace.registry.policies
    view = session_view(
        session, policies, diagnostics=context.frame.diagnostics
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
        kind = var_kind(session, key)
        if kind == "assoc":
            built, bad_words = build_assoc_literal(
                session.assocs.get(key), items, append
            )
            await _assign_var(view, key, built)
            # A plain word in a keyed literal is dropped with a warning
            # and the assignment still succeeds; unlike a declaration's,
            # this voice does not quote the word (pinned on 5.2.37).
            return result(
                text,
                exit_code=assignment_status(context.frame, sub_seq),
                stderr="".join(
                    f"{shell_voice()}{key}: {word}: must use subscript when "
                    "assigning associative array\n"
                    for word in bad_words
                ),
            )
        if (
            append
            and kind == "indexed"
            and not any(keyed_word(word) is not None for word in items)
        ):
            # `arr+=(...)` starts at the extent, so it fills the hole a
            # trailing `unset arr[last]` left but skips interior ones.
            await _landed(push_words(session, policies, key, items))
            return result(
                text, exit_code=assignment_status(context.frame, sub_seq)
            )
        held = session.arrays.get(key) if append else None
        if append and held is None:
            scalar = conversion_scalar(session, key)
            held = None if scalar is None else make_array([scalar])
        # A `[i]=v` element places at i and the next plain word
        # continues from there.
        base = await _fatal_index_literal(
            held,
            items,
            append,
            functools.partial(subscript_index, session, policies=policies),
        )
        await _assign_var(view, key, base)
        return result(
            text, exit_code=assignment_status(context.frame, sub_seq)
        )
    if val_nodes:
        val = await expand_assignment(
            val_nodes[0], context, execute_fn, cs, policies
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
    subscript = None
    if subscript_node is not None:
        # bash discards the rest of the line on a bad assignment
        # subscript (status 1), naming the raw spelling (`m[$e]: bad
        # array subscript`): a blank one, an associative key that
        # expands empty, or an index before the first element. An
        # indexed subscript that merely *expands* empty stays legal
        # (arithmetic on nothing is 0).
        if not get_text(subscript_node)[len(spelled) + 1 : -1]:
            raise _bad_subscript(subscript_node)
        subscript = await _subscript_key_text(
            subscript_node, spelled, context, execute_fn, cs, policies
        )
    # `a=x` writes element 0 of an array and the key "0" of a map,
    # keeping the rest; `a+=x` appends onto it, and `n+=3` on an integer
    # name adds (`declare -i n=5; n+=3` stores 8).
    status = await _landed(
        assign_element(
            session,
            policies,
            key,
            subscript,
            val,
            append,
            diagnostics=context.frame.diagnostics,
        )
    )
    if status == "readonly":
        raise DiscardSignal(
            encode_text(f"{shell_voice()}{key}: readonly variable\n")
        )
    if status == "denied":
        raise DiscardSignal(encode_text(f"{key}: permission denied\n"))
    if status == "subscript":
        raise _bad_subscript(subscript_node)
    # Reassigning OPTIND (even to its current value) restarts the
    # getopts scan at the first letter of the word it names, as bash 5.2
    # does (`OPTIND=1` midway through `-ab` makes getopts read `a` again).
    if key == "OPTIND":
        session._getopts_optind = None
    return result(text, exit_code=assignment_status(context.frame, sub_seq))
