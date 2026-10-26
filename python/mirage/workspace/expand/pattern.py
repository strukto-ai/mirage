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

from mirage.rs.regex import posix_escape
from mirage.shell.call_stack import CallStack
from mirage.shell.escapes import decode_ansi_c
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.utils.glob_walk import escape_glob
from mirage.utils.path import expand_tilde
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.node import expand_node
from mirage.workspace.session.shell_dirs import home_dir

# A piece of a pattern word: its text, and whether it matches only itself.
Piece = tuple[str, bool]


def _unquoted_pieces(text: str) -> list[Piece]:
    """An unquoted word's text: live, each character a backslash
    escapes literal.

    Args:
        text (str): the word's raw source text.
    """
    out: list[Piece] = []
    run = 0
    i = 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            if i > run:
                out.append((text[run:i], False))
            out.append((text[i + 1], True))
            i += 2
            run = i
            continue
        i += 1
    if len(text) > run:
        out.append((text[run:], False))
    return out


async def _pattern_pieces(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
    leading: bool,
) -> list[Piece]:
    """One pattern word as bash 5.2 reads it: text under any quote is
    literal, unquoted text keeps its special characters live with a
    backslash escaping the next one, an expansion's value is live when
    unquoted and literal inside double quotes, and a leading tilde
    names the home directory as literal text. Patterns are never
    word-split, so ``$p`` holding ``a b`` matches the word ``a b``.

    Args:
        ts_node (TSNodeLike): one pattern node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
        leading (bool): whether the node starts the word, the only
            place a tilde prefix stands.
    """
    ntype = ts_node.type
    if ntype in (NT.WORD, NT.EXTGLOB_PATTERN, NT.REGEX):
        raw = get_text(ts_node)
        if leading and raw.startswith("~"):
            expanded = expand_tilde(raw, home_dir(context.session))
            if expanded != raw:
                rest = raw[1:]
                home = expanded[: len(expanded) - len(rest)]
                return [(home, True), *_unquoted_pieces(rest)]
        return _unquoted_pieces(raw)
    if ntype == NT.RAW_STRING:
        return [(get_text(ts_node)[1:-1], True)]
    if ntype == NT.ANSI_C_STRING:
        return [(decode_ansi_c(get_text(ts_node)[2:-1]), True)]
    if ntype == NT.STRING:
        text = await expand_node(
            ts_node, context, execute_fn, call_stack, view=view
        )
        return [(text, True)]
    if ntype == NT.TRANSLATED_STRING:
        for child in ts_node.named_children:
            if child.type == NT.STRING:
                text = await expand_node(
                    child, context, execute_fn, call_stack, view=view
                )
                return [(text, True)]
        return []
    if ntype == NT.CONCATENATION:
        pieces: list[Piece] = []
        children = ts_node.children
        for position, child in enumerate(children):
            # A $"..." inside a concatenation arrives as an anonymous
            # `$` token followed by the string node; the `$` is the
            # translation marker, not text (same rule as expand_node).
            if (
                child.type == "$"
                and position + 1 < len(children)
                and children[position + 1].type == NT.STRING
            ):
                continue
            pieces.extend(
                await _pattern_pieces(
                    child,
                    context,
                    execute_fn,
                    call_stack,
                    view,
                    leading and not pieces,
                )
            )
        return pieces
    text = await expand_node(
        ts_node, context, execute_fn, call_stack, view=view
    )
    return [(text, False)]


async def expand_pattern(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> str:
    """Expand one pattern word into the matcher's glob dialect, as case
    patterns, the right side of ``[[ == ]]`` and quoted
    parameter-expansion operands read it (``_pattern_pieces``).

    Args:
        ts_node (TSNodeLike): one pattern node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
    """
    pieces = await _pattern_pieces(
        ts_node, context, execute_fn, call_stack, view, True
    )
    return "".join(escape_glob(text) if lit else text for text, lit in pieces)


async def expand_regex(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> str:
    """Expand the right side of ``[[ =~ ]]`` into a POSIX extended
    regex, read as a pattern word (``_pattern_pieces``).

    Args:
        ts_node (TSNodeLike): the regex node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
    """
    pieces = await _pattern_pieces(
        ts_node, context, execute_fn, call_stack, view, True
    )
    return _regex_text(pieces)


def _regex_text(pieces: list[Piece]) -> str:
    """Pattern pieces as a POSIX extended regex. A literal character is
    escaped, except inside a bracket expression, where a backslash is a
    member of its own and every character stands for itself: bash reads
    ``['^'a]`` as ``[^a]`` and ``[a'-'c]`` as a range. The pieces are
    joined as they are, so a live backslash escapes only a live character
    after it.

    Args:
        pieces (list[Piece]): from ``_pattern_pieces``.
    """
    chars = [(ch, lit) for text, lit in pieces for ch in text]
    out: list[str] = []
    members = -1
    unclosed: set[str] = set()
    i = 0
    while i < len(chars):
        ch, lit = chars[i]
        if members < 0:
            if lit:
                out.append(posix_escape(ch))
            elif ch == "\\" and i + 1 < len(chars) and not chars[i + 1][1]:
                out.append(ch + chars[i + 1][0])
                i += 1
            else:
                out.append(ch)
                if ch == "[":
                    if i + 1 < len(chars) and chars[i + 1][0] == "^":
                        out.append("^")
                        i += 1
                    members = i + 1
            i += 1
            continue
        nxt = chars[i + 1][0] if i + 1 < len(chars) else ""
        # A delimiter whose closing pair is missing is missing after any
        # later opening too, so the search runs once for it.
        if ch == "[" and nxt in (":", ".", "=") and nxt not in unclosed:
            close = next(
                (
                    j
                    for j in range(i + 2, len(chars) - 1)
                    if chars[j][0] == nxt and chars[j + 1][0] == "]"
                ),
                -1,
            )
            if close >= 0:
                out.extend(c for c, _ in chars[i : close + 2])
                i = close + 2
                continue
            unclosed.add(nxt)
        out.append(ch)
        if ch == "]" and i > members:
            members = -1
        i += 1
    return "".join(out)
