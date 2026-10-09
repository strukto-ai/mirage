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

from mirage.io import IOResult
from mirage.shell.backticks import split_backtick_region
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import (
    ArithError,
    BadSubstitution,
    ReadonlyError,
    named,
)
from mirage.shell.escapes import (
    decode_ansi_c,
    unescape_dquoted,
    unescape_unquoted,
)
from mirage.shell.helpers import byte_offset, get_text, quoted_parts
from mirage.shell.parameter import scan_parameter
from mirage.shell.parse import parse
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.utils.glob_walk import mark_escaped_globs, mark_globs, unmark_globs
from mirage.utils.path import expand_tilde
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.statement import record_status
from mirage.workspace.expand.constants import ARITH_DELIMITERS, ARITH_OPERATORS
from mirage.workspace.expand.fields import join_chunks, value_piece
from mirage.workspace.expand.types import Chunk, Piece
from mirage.workspace.expand.variable import (
    expand_braces,
    is_at_splat,
    land_arith_writes,
    parameter_chunks,
)
from mirage.workspace.session.elements import landed_arith
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.shell_dirs import home_dir


def _folded_whitespace(node: TSNodeLike) -> str:
    """Whitespace tree-sitter folds into an expansion's opening token.

    Inside a double-quoted string, a run of whitespace between two
    expansions is not emitted as string content: it lands inside the
    following node's extent, so `"$a $(b)"` yields a command
    substitution whose text is `" $(b)"`. Every expansion branch has to
    re-emit it or the two values run together. Unquoted words do not
    fold, so the prefix is empty there and this stays a no-op.

    Args:
        node (TSNodeLike): the expansion node being expanded.
    """
    raw = get_text(node)
    return raw[: len(raw) - len(raw.lstrip())]


async def _expand_backtick_region(
    raw: str,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    node: TSNodeLike,
    offset: int,
    call_stack: CallStack | None,
) -> str:
    """Expand a backtick region, one nested line per pair.

    Args:
        raw (str): the region's text, the folded prefix stripped.
        context (EvaluationContext): the session expanding it.
        execute_fn (Callable[..., Any]): the nested-line entry point.
        node (TSNodeLike): the region's node.
        offset (int): where ``raw`` starts in the node's text, in the
            parser's offsets.
        call_stack (CallStack | None): the frames each pair runs on.
    """
    parts: list[str] = []
    for segment in split_backtick_region(raw):
        if not segment.command:
            parts.append(segment.text)
            continue
        # Each pair is its own place on the line: the node holds every
        # touching pair, so the span within it says which one runs,
        # measured as the parser measures the node.
        io = await child_line(
            context,
            execute_fn,
            segment.text,
            node,
            call_stack,
            (
                offset + byte_offset(raw, segment.start),
                offset + byte_offset(raw, segment.end),
            ),
        )
        parts.append(decode_text(await io.materialize_stdout()).rstrip("\n"))
        context.frame.diagnostics.append(await io.materialize_stderr())
        context.frame.cmdsub_seq += 1
        context.frame.cmdsub_status = io.exit_code
        record_status(context.session, io.exit_code, transparent=True)
    return "".join(parts)


async def child_line(
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    text: str,
    node: Any,
    call_stack: CallStack | None,
    span: tuple[int, int] | None = None,
) -> IOResult:
    """Run a substitution's line in a child shell.

    The evaluator isolates the child shell, except for Bash's ``$(< file)``
    optimization, whose filename expands in the parent. It decides from
    a fresh parse of the body, including each pair in a backtick region.
    The line reaches the executor unwrapped,
    under the node that named it, so the pass places its commands
    where they were typed rather than under a subshell of their own.
    The child runs on a copy of the caller's frames: inside a function
    it reads the function's ``$1``, ``return`` ends it, and so does a
    ``break`` from a loop the caller is in.

    Args:
        context (EvaluationContext): the parent shell's session.
        execute_fn (Callable[..., Any]): the workspace's nested-line
            executor.
        text (str): the line the substitution holds.
        node (Any): the tree-sitter node the substitution stands under.
        call_stack (CallStack | None): the caller's frames.
        span (tuple[int, int] | None): the pair's byte span within the
            node, for a backtick region holding several.
    """
    session = context.session
    return await execute_fn(
        text,
        session_id=session.session_id,
        node=node,
        span=span,
        substitution=True,
        call_stack=(call_stack or CallStack()).fork(paren=False),
    )


def _find_first(node: TSNodeLike, ntype: str) -> TSNodeLike | None:
    if node.type == ntype:
        return node
    for child in node.named_children:
        found = _find_first(child, ntype)
        if found is not None:
            return found
    return None


async def expand_arith(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> str:
    """Reconstruct arithmetic expression text for the shared evaluator.

    ``$``-expansions substitute textually (bash performs expansions
    before arithmetic evaluation), while bare variable names stay as
    names so the evaluator can resolve and assign them
    (``$(( y = 3 ))`` needs ``y``, not its value). A bad substitution
    names the expression as written.
    """
    return await named(
        _arith_inside(ts_node),
        _arith_text(ts_node, context, execute_fn, call_stack, view),
    )


def _arith_inside(ts_node: TSNodeLike) -> str:
    text = get_text(ts_node).lstrip()
    for opener, closer in (("$((", "))"), ("((", "))"), ("$[", "]")):
        if text.startswith(opener) and text.endswith(closer):
            return text[len(opener) : -len(closer)]
    return text


async def _arith_text(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> str:
    parts = []
    raw = ts_node.text or b""
    end = 0
    for child in ts_node.children:
        start = child.start_byte - ts_node.start_byte
        parts.append(decode_text(raw[end:start]))
        end = child.end_byte - ts_node.start_byte
        if child.type in ARITH_DELIMITERS:
            continue
        if child.type in (
            NT.BINARY_EXPRESSION,
            NT.UNARY_EXPRESSION,
            NT.PARENTHESIZED_EXPRESSION,
            NT.TERNARY_EXPRESSION,
            NT.POSTFIX_EXPRESSION,
        ):
            parts.append(
                await _arith_text(child, context, execute_fn, call_stack, view)
            )
        elif child.type == "subscript":
            parts.append(
                await _arith_subscript(
                    child, context, execute_fn, call_stack, view
                )
            )
        elif child.type in ARITH_OPERATORS or child.type in (
            NT.NUMBER,
            NT.VARIABLE_NAME,
        ):
            parts.append(get_text(child))
        else:
            parts.append(
                await expand_node(
                    child, context, execute_fn, call_stack, view=view
                )
            )
    parts.append(decode_text(raw[end:]))
    return "".join(parts)


async def _arith_subscript(
    sub_node: TSNodeLike,
    context: EvaluationContext,
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
        sub_node (TSNodeLike): the ``subscript`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view.
    """
    name = ""
    inner: list[TSNodeLike] = []
    for sc in sub_node.named_children:
        if sc.type == NT.VARIABLE_NAME and not name:
            name = get_text(sc)
        else:
            inner.append(sc)
    raw = get_text(sub_node)[len(name) + 1 : -1]
    if not any(ch in raw for ch in "$'\"`"):
        return f"{name}[{raw}]"
    parts = []
    for sc in inner:
        if sc.type in (
            NT.SIMPLE_EXPANSION,
            NT.EXPANSION,
            NT.COMMAND_SUBSTITUTION,
            NT.STRING,
            NT.RAW_STRING,
            NT.ANSI_C_STRING,
            NT.TRANSLATED_STRING,
            NT.CONCATENATION,
        ):
            parts.append(
                await expand_node(
                    sc, context, execute_fn, call_stack, view=view
                )
            )
        else:
            parts.append(get_text(sc))
    return f"{name}[{''.join(parts)}]"


async def _arith_value(
    session: SessionState, view: SessionView | None, expr: str
) -> str:
    """An arithmetic expansion's value. The write-back goes through the
    session view, so a ``pre_session`` rule governs ``$((X=5))`` exactly
    as it governs ``X=5``; an error unwinds as its ``signal``.

    Args:
        session (SessionState): the session the expression reads.
        view (SessionView | None): the gated session view.
        expr (str): the expanded expression.
    """
    try:
        return str(await landed_arith(session, view, expr, land_arith_writes))
    except (ArithError, ReadonlyError) as exc:
        raise exc.signal() from exc


async def expand_node(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> str:
    """Expand a tree-sitter node to the string it stands for.

    Args:
        ts_node (TSNodeLike): the node to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view, for
            the expansions that write; None outside a workspace.
    """
    return unmark_globs(
        await expand_node_marked(
            ts_node, context, execute_fn, call_stack, view=view
        )
    )


async def expand_node_marked(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> str:
    """Expand a node, marking the glob characters quoting made literal.

    Same string as :func:`expand_node`, except that a glob character
    quoting neutralized travels under its own mark. The node is read
    where no field splitting happens, so a splat reads as its elements
    joined (``$@`` on a space, ``$*`` on IFS's first character).

    Args:
        ts_node (TSNodeLike): the node to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view, for
            the expansions that write; None outside a workspace.
    """
    return join_chunks(
        await expand_chunks(
            ts_node, context, execute_fn, call_stack, view=view
        )
    )


async def expand_chunks(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
    quoted: bool = False,
) -> list[Chunk]:
    """Expand a node to the pieces field splitting reads.

    What an unquoted expansion produces splits on IFS, and what quoting
    protects does not; a splat's elements are separate fields.
    ``split_fields`` turns the pieces into words and ``join_chunks``
    into the one string a context without splitting reads.

    Args:
        ts_node (TSNodeLike): the node to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view, for
            the expansions that write; None outside a workspace.
        quoted (bool): whether the node sits inside double quotes.
    """
    try:
        return await _node_chunks(
            ts_node, context, execute_fn, call_stack, view, quoted
        )
    except BadSubstitution as exc:
        raise exc.within(get_text(ts_node).lstrip())


async def _node_chunks(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
    quoted: bool,
) -> list[Chunk]:
    session = context.session
    ntype = ts_node.type

    if ntype == NT.WORD:
        word = unescape_unquoted(mark_escaped_globs(get_text(ts_node)))
        return [Piece(expand_tilde(word, home_dir(session)))]

    if ntype == NT.COMMAND_NAME:
        # The name is a word like any other: $CMD, "quoted", $(sub) all
        # expand. A bare word has one named child (or none) and falls
        # through to its own expansion rule.
        for child in ts_node.named_children:
            return await expand_chunks(
                child, context, execute_fn, call_stack, view=view
            )
        return [Piece(get_text(ts_node))]

    if ntype == NT.SIMPLE_EXPANSION:
        prefix = _folded_whitespace(ts_node)
        raw = get_text(ts_node)[len(prefix) :]
        lead = [Piece(prefix)] if prefix else []
        ref = scan_parameter(raw, 0)
        if ref is None:
            return [*lead, Piece(mark_globs(raw) if quoted else raw)]
        name, end = ref
        tail = raw[end:]
        return [
            *lead,
            *parameter_chunks(name, session, call_stack, quoted),
            *([Piece(mark_globs(tail) if quoted else tail)] if tail else []),
        ]

    if ntype == NT.EXPANSION:
        prefix = _folded_whitespace(ts_node)
        expand_child = partial(
            _expand_child,
            context=context,
            execute_fn=execute_fn,
            call_stack=call_stack,
            view=view,
        )
        braces = await expand_braces(
            ts_node,
            session,
            call_stack,
            expand_child,
            view=view,
            quoted=quoted,
        )
        return [Piece(prefix), *braces] if prefix else braces

    if (
        ntype == NT.PROCESS_SUBSTITUTION
        and context.frame.process_sub is not None
    ):
        return [Piece(await context.frame.process_sub(ts_node))]

    if ntype in (NT.COMMAND_SUBSTITUTION, NT.ARITHMETIC_EXPANSION):
        text = await _substitution(
            ts_node, context, execute_fn, call_stack, view
        )
        prefix = _folded_whitespace(ts_node)
        lead = [Piece(prefix)] if prefix else []
        return [*lead, value_piece(text, quoted)]

    if ntype == NT.CONCATENATION:
        # Each piece carries its own quoting, which is the whole reason
        # marks are per character: `'*'?.txt` joins a marked star to a
        # live question mark and still globs, on the `?` alone.
        chunks: list[Chunk] = []
        children = ts_node.children
        for position, child in enumerate(children):
            # A $"..." in a concatenation arrives as an anonymous `$`
            # token followed by the string node; the `$` is the
            # translation marker, not text. A bare trailing `$` (a$)
            # has no string after it and stays literal.
            if (
                child.type == "$"
                and position + 1 < len(children)
                and children[position + 1].type == NT.STRING
            ):
                continue
            chunks.extend(
                await expand_chunks(
                    child, context, execute_fn, call_stack, view=view
                )
            )
        return chunks

    if ntype == NT.STRING:
        return await _string_chunks(
            ts_node, context, execute_fn, call_stack, view
        )

    if ntype == NT.TRANSLATED_STRING:
        # $"..." asks for a locale translation; no message catalog is
        # ever loaded, so the translation is the identity and the word
        # keeps plain double-quote semantics.
        for child in ts_node.named_children:
            if child.type == NT.STRING:
                return await _string_chunks(
                    child, context, execute_fn, call_stack, view
                )
        return [Piece("")]

    text = await _literal_node(ts_node, context, execute_fn, call_stack, view)
    return [Piece(mark_globs(text) if quoted else text)]


async def _expand_child(
    node: TSNodeLike,
    quoted: bool,
    *,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> list[Chunk]:
    """``expand_chunks`` in the shape ``expand_braces`` calls back.

    Args:
        node (TSNodeLike): the nested node.
        quoted (bool): whether it sits inside double quotes.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view.
    """
    return await expand_chunks(
        node, context, execute_fn, call_stack, view=view, quoted=quoted
    )


async def _string_chunks(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> list[Chunk]:
    """A double-quoted string's pieces, one field unless a splat splits it.

    Everything the quotes enclose is literal, the text and every value
    alike: ``"$p"?.txt`` globs on the ``?`` alone. The quotes open a
    field even around nothing (``""``), except that a ``$@``-style
    splat over no elements, with no other text, is no field at all:
    with no parameters ``"$@"`` and ``"$u$@"`` are nothing, while one
    empty parameter is one empty word. Only the element count decides
    that, never the rendered text.

    A bad substitution names what the quotes enclose, or the whole
    document of a heredoc the string stands for.

    Args:
        node (TSNodeLike): the string node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view.
    """
    chunks: list[Chunk] = [Piece("")]
    splat = False
    yielded = False
    document = getattr(node.parent, "heredoc", None)
    inside = (
        decode_text(document.body)
        if document is not None
        else get_text(node)[1:-1]
    )
    for part in quoted_parts(node):
        if isinstance(part, str):
            chunks.append(Piece(mark_globs(part)))
            continue
        pieces = await named(
            inside,
            expand_chunks(
                part, context, execute_fn, call_stack, view=view, quoted=True
            ),
        )
        if is_at_splat(part):
            splat = True
            yielded = yielded or bool(pieces)
        chunks.extend(pieces)
    if splat and not yielded and not join_chunks(chunks):
        return []
    return chunks


async def _substitution(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> str:
    """A command substitution's output or an arithmetic expansion's value.

    Args:
        ts_node (TSNodeLike): the substitution node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view.
    """
    session = context.session
    prefix = _folded_whitespace(ts_node)
    if ts_node.type == NT.ARITHMETIC_EXPANSION:
        return await _arith_value(
            session,
            view,
            await expand_arith(
                ts_node, context, execute_fn, call_stack, view=view
            ),
        )
    source = (
        getattr(ts_node, "inlined", None)
        or getattr(ts_node, "source_text", ts_node.text)
        or b""
    )
    raw = decode_text(source)[len(prefix) :]
    if raw.startswith("`") and raw.endswith("`"):
        # Backtick regions are re-lexed here rather than trusted from
        # the grammar, which merges adjacent pairs (see
        # split_backtick_region).
        return await _expand_backtick_region(
            raw,
            context,
            execute_fn,
            ts_node,
            len(encode_text(prefix)),
            call_stack,
        )
    if raw.startswith("$((") and raw.endswith("))"):
        # Inside heredoc bodies tree-sitter parses `$((expr))` as a
        # command substitution wrapping a subshell; reparse in
        # command context so it routes to the arithmetic branch.
        sub = ts_node.named_children
        if len(sub) == 1 and sub[0].type == NT.SUBSHELL:
            reparsed = parse("echo " + raw)
            arith = _find_first(reparsed, NT.ARITHMETIC_EXPANSION)
            if arith is not None:
                return await expand_node(
                    arith, context, execute_fn, call_stack, view=view
                )
    # The whole body goes to the evaluator: bash substitutes the
    # full statement list, and picking child nodes dropped every
    # statement after a `;` and every non-command statement
    # (declarations, assignments, control flow).
    inner = raw[2:-1]
    if not inner.strip():
        return ""
    # The substitution names its own node: the nested line's
    # commands stand under it, which is where the pass placed them.
    io = await child_line(context, execute_fn, inner, ts_node, call_stack)
    text = decode_text(await io.materialize_stdout()).rstrip("\n")
    # Record the substitution's status: an assignment-only
    # statement whose value ran substitutions reports the last
    # one's status as its own (see assignment_status), and `$?` reads
    # it in the words that follow (`false; echo $(true) $?` prints 0).
    context.frame.diagnostics.append(await io.materialize_stderr())
    context.frame.cmdsub_seq += 1
    context.frame.cmdsub_status = io.exit_code
    record_status(context.session, io.exit_code, transparent=True)
    return text


async def _literal_node(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> str:
    """The text of a node no expansion splits: quoted words and the rest.

    Args:
        ts_node (TSNodeLike): the node to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        view (SessionView | None): the gated session view.
    """
    ntype = ts_node.type

    if ntype == NT.NUMBER:
        return get_text(ts_node)

    if ntype == NT.STRING_CONTENT:
        return unescape_dquoted(get_text(ts_node))

    if ntype == NT.RAW_STRING:
        raw = get_text(ts_node)
        return mark_globs(raw[1:-1])

    if ntype == NT.ANSI_C_STRING:
        raw = get_text(ts_node)
        return mark_globs(decode_ansi_c(raw[2:-1]))

    if ntype == NT.VARIABLE_ASSIGNMENT:
        raw = get_text(ts_node)
        if "=" in raw:
            key, _, val_part = raw.partition("=")
            val_nodes = [
                c for c in ts_node.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes:
                expanded = await expand_node(
                    val_nodes[0], context, execute_fn, call_stack, view=view
                )
                return f"{key}={expanded}"
            return f"{key}={val_part}"
        return raw

    return get_text(ts_node)
