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

import shlex
from collections.abc import Callable
from functools import partial
from typing import Any

import tree_sitter

from mirage.shell.arith import evaluate_arith
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError
from mirage.shell.escapes import decode_ansi_c
from mirage.shell.helpers import get_text
from mirage.shell.parse import parse
from mirage.shell.types import NodeType as NT
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.constants import ARITH_DELIMITERS, ARITH_OPERATORS
from mirage.workspace.expand.variable import (_lookup_var, expand_braces,
                                              guard_expansion_write)
from mirage.workspace.session import Session, visible_env
from mirage.workspace.session.shell_dirs import home_dir


def _folded_whitespace(node: tree_sitter.Node) -> str:
    """Whitespace tree-sitter folds into an expansion's opening token.

    Inside a double-quoted string, a run of whitespace between two
    expansions is not emitted as string content: it lands inside the
    following node's extent, so `"$a $(b)"` yields a command
    substitution whose text is `" $(b)"`. Every expansion branch has to
    re-emit it or the two values run together. Unquoted words do not
    fold, so the prefix is empty there and this stays a no-op.

    Args:
        node (tree_sitter.Node): the expansion node being expanded.
    """
    raw = get_text(node)
    return raw[:len(raw) - len(raw.lstrip())]


def _split_backtick_segments(raw: str) -> list[tuple[str, bool]]:
    """Split a backtick region into (text, is_command) segments.

    tree-sitter-bash lexes the gap between two backtick substitutions as
    a single token when that gap is empty or whitespace-only, so
    ``\\`a\\` \\`b\\``` arrives as ONE command_substitution node holding
    both commands and the literal text between them. Re-lexing the
    node's own text on unescaped backticks recovers the real segments;
    a single pair simply yields one command segment.

    Inside a command, POSIX keeps the backslash literal except before
    ``$``, `` ` `` and ``\\``, where it escapes. Consuming those pairs
    whole is what makes the parity right: ``\\\\`` is one escaped
    backslash, so a backtick straight after it still closes the region
    rather than reading as an escaped backtick.

    Args:
        raw (str): the node's text, opening and closing with a backtick.
    """
    segments: list[tuple[str, bool]] = []
    buf: list[str] = []
    in_command = False
    i = 0
    while i < len(raw):
        if (raw[i] == "\\" and in_command and i + 1 < len(raw)
                and raw[i + 1] in ("$", "`", "\\")):
            buf.append(raw[i + 1])
            i += 2
            continue
        if raw[i] == "`":
            segments.append(("".join(buf), in_command))
            buf = []
            in_command = not in_command
            i += 1
            continue
        buf.append(raw[i])
        i += 1
    segments.append(("".join(buf), in_command))
    return [(text, cmd) for text, cmd in segments if text or cmd]


async def _expand_backtick_region(
    raw: str,
    session: Session,
    execute_fn: Callable[..., Any],
) -> str:
    parts: list[str] = []
    for text, is_command in _split_backtick_segments(raw):
        if not is_command:
            parts.append(text)
            continue
        io = await execute_fn(text, session_id=session.session_id)
        parts.append((await io.stdout_str()).rstrip("\n"))
        io.sync_exit_code()
        session._cmdsub_seq += 1
        session._cmdsub_status = io.exit_code
    return "".join(parts)


def _unescape_unquoted(text: str) -> str:
    if "\\" not in text:
        return text
    try:
        parts = shlex.split(text, posix=True)
    except ValueError:
        return text
    return parts[0] if parts else text


def unescape_heredoc(text: str) -> str:
    """Unquoted-heredoc escapes: \\$, \\`, \\\\, \\<newline> only.

    Unlike double quotes, \\" stays literal in heredoc bodies.
    """
    if "\\" not in text:
        return text
    text = text.replace("\\\\", "\x00")
    text = text.replace("\\$", "$")
    text = text.replace("\\`", "`")
    text = text.replace("\\\n", "")
    return text.replace("\x00", "\\")


def _find_first(node: tree_sitter.Node, ntype: str) -> tree_sitter.Node | None:
    if node.type == ntype:
        return node
    for child in node.named_children:
        found = _find_first(child, ntype)
        if found is not None:
            return found
    return None


async def expand_arith(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> str:
    """Reconstruct arithmetic expression text for the shared evaluator.

    ``$``-expansions substitute textually (bash performs expansions
    before arithmetic evaluation), while bare variable names stay as
    names so the evaluator can resolve and assign them
    (``$(( y = 3 ))`` needs ``y``, not its value).
    """
    parts = []
    for child in ts_node.children:
        if child.type in ARITH_DELIMITERS:
            continue
        if child.type in (NT.BINARY_EXPRESSION, NT.UNARY_EXPRESSION,
                          NT.PARENTHESIZED_EXPRESSION, NT.TERNARY_EXPRESSION,
                          NT.POSTFIX_EXPRESSION):
            parts.append(await expand_arith(child, session, execute_fn,
                                            call_stack))
        elif child.type in ARITH_OPERATORS:
            parts.append(get_text(child))
        elif child.type == NT.NUMBER:
            parts.append(get_text(child))
        elif child.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                            NT.COMMAND_SUBSTITUTION):
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
        elif child.type == NT.VARIABLE_NAME:
            parts.append(get_text(child))
        else:
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
    return " ".join(parts)


async def expand_node(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> str:
    """Expand a tree-sitter node to a string."""
    ntype = ts_node.type

    if ntype == NT.WORD:
        word = _unescape_unquoted(get_text(ts_node))
        return expand_tilde(word, home_dir(session))

    if ntype == NT.NUMBER:
        return get_text(ts_node)

    if ntype == NT.COMMAND_NAME:
        # The name is a word like any other: $CMD, "quoted", $(sub) all
        # expand. A bare word has one named child (or none) and falls
        # through to its own expansion rule.
        for child in ts_node.named_children:
            return await expand_node(child, session, execute_fn, call_stack)
        return get_text(ts_node)

    if ntype == NT.SIMPLE_EXPANSION:
        prefix = _folded_whitespace(ts_node)
        raw = get_text(ts_node)[len(prefix):]
        for child in ts_node.named_children:
            if child.type == NT.SPECIAL_VARIABLE_NAME:
                return prefix + _lookup_var(get_text(child), session,
                                            call_stack)
        # Slice past the leading "$" rather than searching for it, so
        # `$$` keeps its name instead of splitting into prefix + "".
        return prefix + _lookup_var(raw[1:], session, call_stack)

    if ntype == NT.EXPANSION:
        prefix = _folded_whitespace(ts_node)
        expand_child = partial(expand_node,
                               session=session,
                               execute_fn=execute_fn,
                               call_stack=call_stack)
        return prefix + await expand_braces(ts_node, session, call_stack,
                                            expand_child)

    if ntype == NT.COMMAND_SUBSTITUTION:
        prefix = _folded_whitespace(ts_node)
        raw = get_text(ts_node)[len(prefix):]
        if raw.startswith("`") and raw.endswith("`"):
            # Backtick regions are re-lexed here rather than trusted from
            # the grammar, which merges adjacent pairs (see
            # _split_backtick_segments).
            return prefix + await _expand_backtick_region(
                raw, session, execute_fn)
        if raw.startswith("$((") and raw.endswith("))"):
            # Inside heredoc bodies tree-sitter parses `$((expr))` as a
            # command substitution wrapping a subshell; reparse in
            # command context so it routes to the arithmetic branch.
            sub = ts_node.named_children
            if len(sub) == 1 and sub[0].type == NT.SUBSHELL:
                reparsed = parse("echo " + raw)
                arith = _find_first(reparsed, NT.ARITHMETIC_EXPANSION)
                if arith is not None:
                    return prefix + await expand_node(arith, session,
                                                      execute_fn, call_stack)
        inner_cmds = [
            c for c in ts_node.named_children
            if c.type in (NT.COMMAND, NT.PIPELINE, NT.LIST,
                          NT.REDIRECTED_STATEMENT, NT.SUBSHELL)
        ]
        if not inner_cmds:
            return prefix
        inner = get_text(inner_cmds[0])
        io = await execute_fn(inner, session_id=session.session_id)
        text = (await io.stdout_str()).rstrip("\n")
        # Record the substitution's status: an assignment-only
        # statement whose value ran substitutions reports the last
        # one's status as its own (see assignment_status).
        io.sync_exit_code()
        session._cmdsub_seq += 1
        session._cmdsub_status = io.exit_code
        return prefix + text

    if ntype == NT.ARITHMETIC_EXPANSION:
        prefix = _folded_whitespace(ts_node)
        expr = await expand_arith(ts_node, session, execute_fn, call_stack)
        try:
            # Reads resolve against the visible env, so a hidden name
            # counts as unset; the write-back below lands on the raw
            # env (policy-ungated until expansion goes async), with the
            # hidden gate applied by guard_expansion_write.
            value, updates = evaluate_arith(expr, visible_env(session))
        except ArithError:
            return get_text(ts_node)
        guard_expansion_write(session, *updates)
        session.env.update(updates)
        return prefix + str(value)

    if ntype == NT.CONCATENATION:
        parts = []
        children = ts_node.children
        for position, child in enumerate(children):
            # A $"..." in a concatenation arrives as an anonymous `$`
            # token followed by the string node; the `$` is the
            # translation marker, not text. A bare trailing `$` (a$)
            # has no string after it and stays literal.
            if (child.type == "$" and position + 1 < len(children)
                    and children[position + 1].type == NT.STRING):
                continue
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
        return "".join(parts)

    if ntype == NT.STRING:
        # The newline bytes of a multi-line string belong to no child
        # token, so each row step re-emits them; the quote tokens
        # anchor the count, which keeps leading, trailing and blank
        # lines alive ("a\n\nb" is five bytes in bash).
        parts = []
        prev_end_row = None
        for child in ts_node.children:
            if prev_end_row is not None:
                parts.append("\n" * (child.start_point[0] - prev_end_row))
            prev_end_row = child.end_point[0]
            if child.type == NT.DQUOTE:
                continue
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
        return "".join(parts)

    if ntype == NT.STRING_CONTENT:
        # Bash double-quote escapes: \$, \`, \", \\, \<newline>.
        # Everything else preserves the backslash literally.
        text = get_text(ts_node)
        text = text.replace("\\\\", "\x00")
        text = text.replace('\\"', '"')
        text = text.replace("\\$", "$")
        text = text.replace("\\`", "`")
        text = text.replace("\\\n", "")
        text = text.replace("\x00", "\\")
        return text

    if ntype == NT.RAW_STRING:
        raw = get_text(ts_node)
        return raw[1:-1]

    if ntype == NT.ANSI_C_STRING:
        raw = get_text(ts_node)
        return decode_ansi_c(raw[2:-1])

    if ntype == NT.TRANSLATED_STRING:
        # $"..." asks for a locale translation; no message catalog is
        # ever loaded, so the translation is the identity and the word
        # keeps plain double-quote semantics.
        for child in ts_node.named_children:
            if child.type == NT.STRING:
                return await expand_node(child, session, execute_fn,
                                         call_stack)
        return ""

    if ntype == NT.VARIABLE_ASSIGNMENT:
        raw = get_text(ts_node)
        if "=" in raw:
            key, _, val_part = raw.partition("=")
            val_nodes = [
                c for c in ts_node.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes:
                expanded = await expand_node(val_nodes[0], session, execute_fn,
                                             call_stack)
                return f"{key}={expanded}"
            return f"{key}={val_part}"
        return raw

    return get_text(ts_node)
