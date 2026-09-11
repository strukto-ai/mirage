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
from functools import partial
from typing import Any

import tree_sitter

from mirage.io import IOResult
from mirage.ops.types import SessionView
from mirage.shell.arith import evaluate_arith
from mirage.shell.backticks import split_backtick_region
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.escapes import (decode_ansi_c, unescape_dquoted,
                                  unescape_unquoted)
from mirage.shell.helpers import byte_offset, get_text
from mirage.shell.parse import parse
from mirage.shell.types import NodeType as NT
from mirage.utils.glob_walk import mark_escaped_globs, mark_globs, unmark_globs
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.constants import ARITH_DELIMITERS, ARITH_OPERATORS
from mirage.workspace.expand.variable import (_lookup_var, expand_braces,
                                              land_arith_writes)
from mirage.workspace.session import Session, visible_env
from mirage.workspace.session.shell_dirs import home_dir
from mirage.workspace.session.state import random_reader, session_elements


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


async def _expand_backtick_region(
    raw: str,
    session: Session,
    execute_fn: Callable[..., Any],
    node: tree_sitter.Node,
    offset: int,
) -> str:
    """Expand a backtick region, one nested line per pair.

    Args:
        raw (str): the region's text, the folded prefix stripped.
        session (Session): the session expanding it.
        execute_fn (Callable[..., Any]): the nested-line door.
        node (tree_sitter.Node): the region's node.
        offset (int): where ``raw`` starts in the node's text, in the
            parser's offsets.
    """
    parts: list[str] = []
    for segment in split_backtick_region(raw):
        if not segment.command:
            parts.append(segment.text)
            continue
        # Each pair is its own place on the line: the node holds every
        # touching pair, so the span within it says which one runs,
        # measured as the parser measures the node.
        io = await child_line(session, execute_fn, segment.text, node,
                              (offset + byte_offset(raw, segment.start),
                               offset + byte_offset(raw, segment.end)))
        parts.append((await io.stdout_str()).rstrip("\n"))
        session._diagnostics.append(await io.materialize_stderr())
        session._cmdsub_seq += 1
        session._cmdsub_status = io.exit_code
    return "".join(parts)


async def child_line(session: Session,
                     execute_fn: Callable[..., Any],
                     text: str,
                     node: Any,
                     span: tuple[int, int] | None = None) -> IOResult:
    """Run a substitution's line in a child shell.

    bash forks for ``$(...)`` and backticks, so what the line assigns,
    ``cd``s or seeds (``RANDOM``) never reaches the parent: the session
    is restored around the run, as ``handle_subshell`` restores it
    around a ``( )`` body. The line reaches the executor unwrapped,
    under the node that named it, so the pass places its commands
    where they were typed rather than under a subshell of their own.

    Args:
        session (Session): the parent shell's session.
        execute_fn (Callable[..., Any]): the workspace's nested-line
            executor.
        text (str): the line the substitution holds.
        node (Any): the tree-sitter node the substitution stands under.
        span (tuple[int, int] | None): the pair's byte span within the
            node, for a backtick region holding several.
    """
    saved = session.snapshot()
    try:
        return await execute_fn(text,
                                session_id=session.session_id,
                                node=node,
                                span=span)
    finally:
        session.restore(saved)


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


def arith_exit(expr: str, exc: ArithError) -> ExitSignal:
    """The fatal shape of an arithmetic expansion error.

    bash aborts the whole line on a bad ``$((...))`` in a
    non-interactive shell, exactly as it does for ``${var:?}``: the
    command never runs, the line exits 1, and a subshell or pipeline
    segment containing it reports 1. The old return of the expansion's
    own text printed ``$((1/0))`` with exit 0, the silent wrong answer
    the fail-loud rule forbids. The diagnostic is the expression as
    expanded (``1/0`` for ``$((1/$x))`` with ``x=0``), trimmed, in the
    house style that drops bash's ``line N:`` prefix and its
    ``(error token is ...)`` suffix, the same shape ``(( ))`` reports.

    Args:
        expr (str): the expression text handed to the evaluator.
        exc (ArithError): what the evaluator refused.
    """
    return ExitSignal(1,
                      stderr=f"bash: {expr.strip()}: {exc}\n".encode(),
                      contained_code=1)


async def expand_arith(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> str:
    """Reconstruct arithmetic expression text for the shared evaluator.

    ``$``-expansions substitute textually (bash performs expansions
    before arithmetic evaluation), while bare variable names stay as
    names so the evaluator can resolve and assign them
    (``$(( y = 3 ))`` needs ``y``, not its value).
    """
    parts = []
    raw = ts_node.text or b""
    end = 0
    for child in ts_node.children:
        start = child.start_byte - ts_node.start_byte
        parts.append(raw[end:start].decode("utf-8"))
        end = child.end_byte - ts_node.start_byte
        if child.type in ARITH_DELIMITERS:
            continue
        if child.type in (NT.BINARY_EXPRESSION, NT.UNARY_EXPRESSION,
                          NT.PARENTHESIZED_EXPRESSION, NT.TERNARY_EXPRESSION,
                          NT.POSTFIX_EXPRESSION):
            parts.append(await expand_arith(child,
                                            session,
                                            execute_fn,
                                            call_stack,
                                            view=view))
        elif child.type == "subscript":
            parts.append(await _arith_subscript(child, session, execute_fn,
                                                call_stack, view))
        elif child.type in ARITH_OPERATORS:
            parts.append(get_text(child))
        elif child.type == NT.NUMBER:
            parts.append(get_text(child))
        elif child.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                            NT.COMMAND_SUBSTITUTION):
            parts.append(await expand_node(child,
                                           session,
                                           execute_fn,
                                           call_stack,
                                           view=view))
        elif child.type == NT.VARIABLE_NAME:
            parts.append(get_text(child))
        else:
            parts.append(await expand_node(child,
                                           session,
                                           execute_fn,
                                           call_stack,
                                           view=view))
    parts.append(raw[end:].decode("utf-8"))
    return "".join(parts).strip()


async def _arith_subscript(
    sub_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> str:
    """Reconstruct one element reference for the arithmetic tokenizer.

    The subscript's ``$``-expansions substitute here, since bash
    expands the whole expression text before evaluating it, while a
    literal interior rides verbatim: for an associative array the text
    *is* the key (``m[k]`` reads the key ``k`` even when a variable
    ``k`` exists), and for an indexed one the evaluator's resolver
    still gets the arithmetic spelling.

    Args:
        sub_node (tree_sitter.Node): the ``subscript`` node.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the session plane's gated door.
    """
    name = ""
    inner: list[tree_sitter.Node] = []
    for sc in sub_node.named_children:
        if sc.type == NT.VARIABLE_NAME and not name:
            name = get_text(sc)
        else:
            inner.append(sc)
    raw = get_text(sub_node)[len(name) + 1:-1]
    if not any(ch in raw for ch in "$'\"`"):
        return f"{name}[{raw}]"
    parts = []
    for sc in inner:
        if sc.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                       NT.COMMAND_SUBSTITUTION, NT.STRING, NT.RAW_STRING,
                       NT.ANSI_C_STRING, NT.TRANSLATED_STRING,
                       NT.CONCATENATION):
            parts.append(await expand_node(sc,
                                           session,
                                           execute_fn,
                                           call_stack,
                                           view=view))
        else:
            parts.append(get_text(sc))
    return f"{name}[{''.join(parts)}]"


async def expand_node(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> str:
    """Expand a tree-sitter node to the string it stands for.

    Args:
        ts_node (tree_sitter.Node): the node to expand.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the session plane's gated door, for
            the expansions that write; None outside a workspace.
    """
    return unmark_globs(await expand_node_marked(ts_node,
                                                 session,
                                                 execute_fn,
                                                 call_stack,
                                                 view=view))


async def expand_node_marked(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> str:
    """Expand a node, marking the glob characters quoting made literal.

    Same string as :func:`expand_node`, except that a glob character
    quoting neutralized travels under its own mark.
    Only pathname expansion cares, so this is what ``expand_words``
    reads while every other caller takes the unmarked wrapper above.

    Args:
        ts_node (tree_sitter.Node): the node to expand.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the session plane's gated door, for
            the expansions that write; None outside a workspace.
    """
    ntype = ts_node.type

    if ntype == NT.WORD:
        word = unescape_unquoted(mark_escaped_globs(get_text(ts_node)))
        return expand_tilde(word, home_dir(session))

    if ntype == NT.NUMBER:
        return get_text(ts_node)

    if ntype == NT.COMMAND_NAME:
        # The name is a word like any other: $CMD, "quoted", $(sub) all
        # expand. A bare word has one named child (or none) and falls
        # through to its own expansion rule.
        for child in ts_node.named_children:
            return await expand_node(child,
                                     session,
                                     execute_fn,
                                     call_stack,
                                     view=view)
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
        return prefix + await expand_braces(
            ts_node, session, call_stack, expand_child, view=view)

    if ntype == NT.COMMAND_SUBSTITUTION:
        prefix = _folded_whitespace(ts_node)
        raw = get_text(ts_node)[len(prefix):]
        if raw.startswith("`") and raw.endswith("`"):
            # Backtick regions are re-lexed here rather than trusted from
            # the grammar, which merges adjacent pairs (see
            # split_backtick_region).
            return prefix + await _expand_backtick_region(
                raw, session, execute_fn, ts_node, len(prefix.encode()))
        if raw.startswith("$((") and raw.endswith("))"):
            # Inside heredoc bodies tree-sitter parses `$((expr))` as a
            # command substitution wrapping a subshell; reparse in
            # command context so it routes to the arithmetic branch.
            sub = ts_node.named_children
            if len(sub) == 1 and sub[0].type == NT.SUBSHELL:
                reparsed = parse("echo " + raw)
                arith = _find_first(reparsed, NT.ARITHMETIC_EXPANSION)
                if arith is not None:
                    return prefix + await expand_node(
                        arith, session, execute_fn, call_stack, view=view)
        # The whole body goes to the evaluator: bash substitutes the
        # full statement list, and picking child nodes dropped every
        # statement after a `;` and every non-command statement
        # (declarations, assignments, control flow).
        inner = raw[2:-1]
        if not inner.strip():
            return prefix
        # The substitution names its own node: the nested line's
        # commands stand under it, which is where the pass placed them.
        io = await child_line(session, execute_fn, inner, ts_node)
        text = (await io.stdout_str()).rstrip("\n")
        # Record the substitution's status: an assignment-only
        # statement whose value ran substitutions reports the last
        # one's status as its own (see assignment_status).
        session._diagnostics.append(await io.materialize_stderr())
        session._cmdsub_seq += 1
        session._cmdsub_status = io.exit_code
        return prefix + text

    if ntype == NT.ARITHMETIC_EXPANSION:
        prefix = _folded_whitespace(ts_node)
        expr = await expand_arith(ts_node,
                                  session,
                                  execute_fn,
                                  call_stack,
                                  view=view)
        try:
            # Reads resolve against the visible env, so a hidden name
            # counts as unset; the write-back below goes through the
            # session plane's door, so a pre_session rule governs
            # `$((X=5))` exactly as it governs `X=5`.
            reader = random_reader(session)
            result = evaluate_arith(expr,
                                    visible_env(session),
                                    elements=session_elements(session, reader),
                                    read_var=reader.read,
                                    wrote_var=reader.wrote)
        except ArithError as exc:
            # bash bound the assignments made before the error, RANDOM's
            # seed included; they land before the line dies.
            await land_arith_writes(session, view, exc.writes, reader)
            raise arith_exit(expr, exc) from exc
        await land_arith_writes(session, view, result.writes, reader)
        return prefix + str(result.value)

    if ntype == NT.CONCATENATION:
        # Each piece carries its own quoting, which is the whole reason
        # marks are per character: `'*'?.txt` joins a marked star to a
        # live question mark and still globs, on the `?` alone.
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
            parts.append(await expand_node_marked(child,
                                                  session,
                                                  execute_fn,
                                                  call_stack,
                                                  view=view))
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
            parts.append(await expand_node(child,
                                           session,
                                           execute_fn,
                                           call_stack,
                                           view=view))
        # Everything the quotes enclose is literal, the text and any
        # value expanded inside it alike: "$p"?.txt globs on the `?`
        # while $p?.txt globs on whatever `p` holds too.
        return mark_globs("".join(parts))

    if ntype == NT.STRING_CONTENT:
        return unescape_dquoted(get_text(ts_node))

    if ntype == NT.RAW_STRING:
        raw = get_text(ts_node)
        return mark_globs(raw[1:-1])

    if ntype == NT.ANSI_C_STRING:
        raw = get_text(ts_node)
        return mark_globs(decode_ansi_c(raw[2:-1]))

    if ntype == NT.TRANSLATED_STRING:
        # $"..." asks for a locale translation; no message catalog is
        # ever loaded, so the translation is the identity and the word
        # keeps plain double-quote semantics.
        for child in ts_node.named_children:
            if child.type == NT.STRING:
                return await expand_node_marked(child,
                                                session,
                                                execute_fn,
                                                call_stack,
                                                view=view)
        return ""

    if ntype == NT.VARIABLE_ASSIGNMENT:
        raw = get_text(ts_node)
        if "=" in raw:
            key, _, val_part = raw.partition("=")
            val_nodes = [
                c for c in ts_node.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes:
                expanded = await expand_node(val_nodes[0],
                                             session,
                                             execute_fn,
                                             call_stack,
                                             view=view)
                return f"{key}={expanded}"
            return f"{key}={val_part}"
        return raw

    return get_text(ts_node)
