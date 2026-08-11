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
from mirage.shell.escapes import decode_ansi_c
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.utils.glob_walk import escape_glob
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.node import expand_node
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir


def _unquoted_pattern(text: str) -> str:
    """An unquoted word as a pattern: globs live, backslash escapes.

    Args:
        text (str): the word's raw source text.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            out.append(escape_glob(text[i + 1]))
            i += 2
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


async def _quoted_string_pattern(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> str:
    """A double-quoted pattern segment: everything in it is literal.

    Mirrors expand_node's string walk (dquote skipping, the multi-line
    newline re-emit), but the value of each piece - string content and
    quoted expansions alike - is escaped so its glob characters match
    themselves.

    Args:
        ts_node (tree_sitter.Node): the string node.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
    """
    parts: list[str] = []
    prev_end_row = None
    for child in ts_node.children:
        if prev_end_row is not None:
            parts.append("\n" * (child.start_point[0] - prev_end_row))
        prev_end_row = child.end_point[0]
        if child.type == NT.DQUOTE:
            continue
        expanded = await expand_node(child, session, execute_fn, call_stack)
        parts.append(escape_glob(expanded))
    return "".join(parts)


async def expand_pattern(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> str:
    """Expand one pattern word into the matcher's glob dialect.

    bash 5.2 semantics, shared by case patterns, the ``[[ == ]]`` right
    side and quoted parameter-expansion operands: text under any quote
    matches literally, unquoted text keeps its glob characters live
    with backslash escaping the next character, and an expansion's
    value is a live pattern when unquoted but literal inside double
    quotes. Patterns are never word-split, so ``$p`` holding ``a b``
    matches the word ``a b``.

    Args:
        ts_node (tree_sitter.Node): one pattern node.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
    """
    ntype = ts_node.type
    if ntype in (NT.WORD, NT.EXTGLOB_PATTERN):
        raw = get_text(ts_node)
        if raw.startswith("~"):
            raw = expand_tilde(raw, home_dir(session))
        return _unquoted_pattern(raw)
    if ntype == NT.RAW_STRING:
        return escape_glob(get_text(ts_node)[1:-1])
    if ntype == NT.ANSI_C_STRING:
        return escape_glob(decode_ansi_c(get_text(ts_node)[2:-1]))
    if ntype == NT.STRING:
        return await _quoted_string_pattern(ts_node, session, execute_fn,
                                            call_stack)
    if ntype == NT.TRANSLATED_STRING:
        for child in ts_node.named_children:
            if child.type == NT.STRING:
                return await _quoted_string_pattern(child, session, execute_fn,
                                                    call_stack)
        return ""
    if ntype == NT.CONCATENATION:
        parts = []
        children = ts_node.children
        for position, child in enumerate(children):
            # A $"..." inside a concatenation arrives as an anonymous
            # `$` token followed by the string node; the `$` is the
            # translation marker, not text (same rule as expand_node).
            if (child.type == "$" and position + 1 < len(children)
                    and children[position + 1].type == NT.STRING):
                continue
            parts.append(await expand_pattern(child, session, execute_fn,
                                              call_stack))
        return "".join(parts)
    return await expand_node(ts_node, session, execute_fn, call_stack)
