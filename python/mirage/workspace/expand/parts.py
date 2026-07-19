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

from collections.abc import Callable
from typing import Any

import tree_sitter

from mirage.shell.call_stack import CallStack
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.types import PathSpec
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.brace import (expand_template, make_inert,
                                           substitute)
from mirage.workspace.expand.classify import classify_word
from mirage.workspace.expand.constants import (BRACE_LITERAL_TYPES,
                                               BRACE_WORD_TYPES, SPLIT_TYPES)
from mirage.workspace.expand.node import _unescape_unquoted, expand_node
from mirage.workspace.expand.variable import _PARAM_OPS
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir


def _has_at_expansion(node: tree_sitter.Node) -> bool:
    for child in node.children:
        if (child.type == NT.SIMPLE_EXPANSION and get_text(child) == "$@"):
            return True
    return False


def _array_at_name(child: tree_sitter.Node) -> str | None:
    if child.type != NT.EXPANSION:
        return None
    # Any operator (length #, slice :, strip/replace, indirection !)
    # disqualifies the plain-splat fast path; expand_braces owns those.
    has_op = any(c.type in _PARAM_OPS and not c.is_named
                 for c in child.children)
    if has_op:
        return None
    sub = next((c for c in child.named_children if c.type == "subscript"),
               None)
    if sub is None:
        return None
    idx_text = ""
    var_name = None
    for sc in sub.named_children:
        if sc.type == NT.VARIABLE_NAME:
            var_name = get_text(sc)
        else:
            idx_text = get_text(sc)
    if var_name and idx_text == "@":
        return var_name
    return None


def _string_has_array_at(node: tree_sitter.Node) -> bool:
    return any(_array_at_name(c) is not None for c in node.children)


async def _expand_string_with_array(
    node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> list[str]:
    """Expand a string containing one or more "${a[@]}" into multiple words.

    Bash semantics: "prefix${a[@]}suffix" with a=(1 2 3) produces three
    words: "prefix1", "2", "3suffix". Single-element arrays merge prefix
    and suffix into one word; empty arrays still produce prefix+suffix.
    """
    arrays = getattr(session, "arrays", {})
    fragments: list[str] = [""]
    for child in node.children:
        if child.type == NT.DQUOTE:
            continue
        arr_name = _array_at_name(child)
        if arr_name is not None:
            arr = arrays.get(arr_name)
            if not arr:
                continue
            if len(arr) == 1:
                fragments[-1] = fragments[-1] + arr[0]
            else:
                fragments[-1] = fragments[-1] + arr[0]
                fragments.extend(arr[1:-1])
                fragments.append(arr[-1])
            continue
        text = await expand_node(child, session, execute_fn, call_stack)
        fragments[-1] = fragments[-1] + text
    return fragments


def _get_positional_args(session: Session,
                         call_stack: CallStack | None) -> list[str]:
    if call_stack and call_stack.get_all_positional():
        return call_stack.get_all_positional()
    return getattr(session, "positional_args", None) or []


async def _expand_brace_word(
    node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> list[str] | None:
    """Brace-expand a concatenation or brace_expression into words.

    Literal word tokens form the brace template; every other child
    (expansions, strings, substitutions) expands first and joins as an
    inert atom, so `{a,$v}` alternates on the expanded value while
    `{1..$n}` stays literal, matching bash's brace-before-parameter
    ordering. Deliberate divergence: bash rewrites `$v{a,b}` to
    `$va $vb` before parameter expansion; here the prefix keeps its
    own expansion (`prea preb`), which is the useful reading.

    Args:
        node (tree_sitter.Node): concatenation or brace_expression.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    pieces: list[str] = []
    values: list[str] = []
    for child in node.children:
        if not child.is_named or child.type in BRACE_LITERAL_TYPES:
            pieces.append(get_text(child))
        else:
            values.append(await expand_node(child, session, execute_fn,
                                            call_stack))
            pieces.append(make_inert(len(values) - 1))
    words = expand_template("".join(pieces))
    if words is None:
        return None
    home = home_dir(session)
    return [
        substitute(expand_tilde(_unescape_unquoted(w), home), values)
        for w in words
    ]


async def expand_parts(
    parts: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> list[str]:
    """Expand a list of tree-sitter child nodes to strings."""
    result = []
    for p in parts:
        if p.type == NT.STRING and _has_at_expansion(p):
            positional = _get_positional_args(session, call_stack)
            if positional:
                result.extend(positional)
                continue
        if p.type == NT.STRING and _string_has_array_at(p):
            words = await _expand_string_with_array(p, session, execute_fn,
                                                    call_stack)
            result.extend(words)
            continue
        if p.type in BRACE_WORD_TYPES:
            brace_words = await _expand_brace_word(p, session, execute_fn,
                                                   call_stack)
            if brace_words is not None:
                # Empty unquoted words vanish, like bash: {,x} -> x.
                result.extend(w for w in brace_words if w)
                continue
        expanded = await expand_node(p, session, execute_fn, call_stack)
        if p.type == NT.COMMAND_SUBSTITUTION:
            for word in expanded.split():
                if word:
                    result.append(word)
            continue
        elif p.type in SPLIT_TYPES:
            for word in expanded.split():
                if word:
                    result.append(word)
        elif p.type == NT.STRING:
            # A quoted word stays a word even when it expands to "" (echo
            # "" or "$EMPTY"), except "$@"/"${a[@]}" which yield zero words.
            if expanded or not _has_at_expansion(p):
                result.append(expanded)
        elif p.type == NT.RAW_STRING:
            result.append(expanded)
        else:
            if expanded:
                result.append(expanded)
    return result


async def expand_and_classify(
    words: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    cwd: str,
    call_stack: CallStack | None = None,
) -> list[str | PathSpec]:
    """Expand words, classify as PathSpec or text.

    Used by for/select where concrete values are needed
    before iteration.
    """
    expanded = await expand_parts(words, session, execute_fn, call_stack)
    return [classify_word(w, registry, cwd) for w in expanded]
