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
from collections.abc import Callable, Iterator, Sequence
from dataclasses import replace
from types import SimpleNamespace
from typing import cast

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.constants import (
    FD_BOTH,
    FD_CLOSE,
    FD_STDERR,
    FD_STDIN,
    FD_STDOUT,
)
from mirage.shell.escapes import (
    decode_ansi_c,
    unescape_dquoted,
    unescape_unquoted,
)
from mirage.shell.parse.program import ProgramNode
from mirage.shell.types import (
    FunctionBody,
    PipelineStages,
    ProcessSubDirection,
    Redirect,
    RedirectKind,
    TSNodeLike,
)
from mirage.shell.types import NodeType as NT
from mirage.utils.path import expand_tilde


def get_text(node: TSNodeLike) -> str:
    """Get the text content of a node."""
    return decode_text(node.text or b"")


def same_line(root: TSNodeLike, before: TSNodeLike, after: TSNodeLike) -> bool:
    """Whether ``after`` stands on ``before``'s line within ``root``: no
    newline between them. The parse has joined continued lines and folded
    each heredoc body into its statement, so a newline between two
    statements is a line break.

    Args:
        root (TSNodeLike): the program both stand in.
        before (TSNodeLike): the earlier node.
        after (TSNodeLike): the later one.
    """
    text = root.text or b""
    base = root.start_byte
    return b"\n" not in text[before.end_byte - base : after.start_byte - base]


def tree_root(node: TSNodeLike) -> TSNodeLike:
    """The root of the tree ``node`` belongs to.

    Args:
        node (TSNodeLike): any node of the tree.
    """
    while node.parent is not None:
        node = node.parent
    return node


def read_row(node: TSNodeLike) -> int:
    """The row the shell began reading ``node``'s command on.

    bash reads a whole line before running any of it, and a complete
    command spanning lines whole, with the rest of the line it ends on:
    a command after a `;`, or inside a group that spans rows, was read
    with the ones before it.

    Args:
        node (TSNodeLike): a node of a parsed program.
    """
    top = node
    while top.parent is not None and top.parent.parent is not None:
        top = top.parent
    root = top.parent if top.parent is not None else top
    before = top.prev_sibling
    while before is not None and same_line(root, before, top):
        top, before = before, before.prev_sibling
    return top.start_point[0]


def source_parts(node: TSNodeLike) -> Iterator[str | TSNodeLike]:
    """A node's children with the source text between them.

    The parser consumes some text without giving it a node: whitespace
    and newlines inside a double-quoted string, and the whitespace or
    line continuation opening a ``${v:-word}`` operand. Only the node's
    own source still holds that text, so it is sliced out between child
    extents rather than rebuilt from row or byte counts, which lose
    tabs, newlines and escapes.

    Args:
        node (TSNodeLike): the parent node.
    """
    source = node.text or b""
    end = node.start_byte
    for child in node.children:
        if child.start_byte > end:
            yield decode_text(
                source[
                    end - node.start_byte : child.start_byte - node.start_byte
                ]
            )
        end = child.end_byte
        yield child


def quoted_parts(node: TSNodeLike) -> Iterator[str | TSNodeLike]:
    """Walk a double-quoted string without losing scanner-owned text.

    The text between children is the string's own, and the closing
    quote token can carry the whitespace before it. Expansion nodes
    keep their own folded prefixes.

    Args:
        node (TSNodeLike): a double-quoted string node.
    """
    for part in source_parts(node):
        if isinstance(part, str):
            yield unescape_dquoted(part)
        elif part.type == NT.DQUOTE:
            yield unescape_dquoted(get_text(part)[:-1])
        else:
            yield part


def byte_offset(text: str, index: int) -> int:
    """Where an index into a node's text falls in the parser's offsets.

    The parser places a node by the bytes of the UTF-8 source, so an
    index counted in code points reads one place too early for every
    multibyte character before it. ``grep -ob`` reads the same answer
    for the same reason.

    Bytes that are not valid UTF-8 ride as surrogate escapes and each
    stand for one byte, which is what makes the count exact. That is a
    requirement on the caller, not a hope: grep's family decodes every
    line through ``decode_text`` for it.

    Args:
        text (str): the text the index is into.
        index (int): a code-point index into it.
    """
    return len(text[:index].encode("utf-8", errors="surrogateescape"))


def get_command_name(node: TSNodeLike) -> str:
    """Get the command name string."""
    for c in node.named_children:
        if c.type == NT.COMMAND_NAME:
            return decode_text(c.text or b"")
    return ""


def get_parts(node: TSNodeLike) -> list[TSNodeLike]:
    """Get command parts as child nodes.

    Preserves expansion nodes for later processing. A bare ``$`` word
    is an anonymous token rather than a named child, but bash passes it
    through as a literal argument (``echo $`` prints ``$``), so it is
    the one anonymous child that stays - unless a string starts at its
    very next byte, where it is the translation marker of ``$"..."``
    and the string node carries the whole word.
    """
    children = node.children
    parts: list[TSNodeLike] = []
    for position, c in enumerate(children):
        if c.is_named and c.type not in REDIRECT_NODE_TYPES:
            parts.append(c)
        elif c.type == "$":
            nxt = (
                children[position + 1]
                if position + 1 < len(children)
                else None
            )
            if (
                nxt is None
                or nxt.type != NT.STRING
                or nxt.start_byte != c.end_byte
            ):
                parts.append(c)
    return parts


def brace_expands(text: str) -> bool:
    """Whether unquoted text holds a brace expansion (``{a,b}``,
    ``{1..3}``), which the shell turns into several words.

    Args:
        text (str): the word as typed.
    """
    start = -1
    for position, char in enumerate(text):
        if char == "{":
            start = position
        elif char == "}" and start >= 0:
            body = text[start + 1 : position]
            if "," in body or ".." in body:
                return True
            start = -1
    return False


def literal_word(node: TSNodeLike, home: str | None = None) -> str | None:
    """The text a word names before any expansion, or None.

    A word is literal when nothing in it waits on the shell: a plain
    word, a number, a quoted string with no expansion inside, or a
    concatenation of those. Quotes are removed, escapes resolved and a
    leading unquoted ``~`` expanded the way expansion would. A word
    carrying a parameter, command, arithmetic or process substitution,
    or a brace expression, answers None: what it names is known only
    when it runs.

    Args:
        node (TSNodeLike): a command word node, or the
            command_name wrapping one.
        home (str | None): the home directory a leading ``~`` names;
            None leaves it literal, as bash does with no ``$HOME``.
    """
    ntype = node.type
    if ntype == NT.COMMAND_NAME:
        named = node.named_children
        return literal_word(named[0], home) if named else get_text(node)
    if ntype in (NT.WORD, NT.NUMBER, NT.CONCATENATION) and brace_expands(
        get_text(node)
    ):
        return None
    if ntype in (NT.WORD, NT.NUMBER):
        return expand_tilde(unescape_unquoted(get_text(node)), home)
    if ntype == NT.RAW_STRING:
        return get_text(node)[1:-1]
    if ntype == NT.ANSI_C_STRING:
        return decode_ansi_c(get_text(node)[2:-1])
    if ntype == NT.TRANSLATED_STRING:
        for child in node.named_children:
            if child.type == NT.STRING:
                return literal_word(child)
        return ""
    if ntype == NT.STRING:
        pieces: list[str] = []
        for part in quoted_parts(node):
            if isinstance(part, str):
                pieces.append(part)
                continue
            if part.type != NT.STRING_CONTENT:
                return None
            pieces.append(unescape_dquoted(get_text(part)))
        return "".join(pieces)
    if ntype == NT.CONCATENATION:
        pieces = []
        children = node.children
        for position, child in enumerate(children):
            # The `$` of a `$"..."` is the translation marker, not text.
            if (
                child.type == "$"
                and position + 1 < len(children)
                and children[position + 1].type == NT.STRING
            ):
                continue
            # Only a leading unquoted piece carries a tilde prefix.
            piece = literal_word(child, home if not pieces else None)
            if piece is None:
                return None
            pieces.append(piece)
        return "".join(pieces)
    if ntype == "$":
        return "$"
    return None


def split_env_prefix(
    parts: list[TSNodeLike],
) -> tuple[list[TSNodeLike], list[TSNodeLike]]:
    """Split FOO=1 BAR=2 cmd parts into (assignments, remaining).

    The single structural rule for env-prefixed commands.
    """
    assignments: list[TSNodeLike] = []
    remaining: list[TSNodeLike] = []
    saw_command_name = False
    for p in parts:
        if not saw_command_name and p.type == NT.VARIABLE_ASSIGNMENT:
            assignments.append(p)
            continue
        if p.type == NT.COMMAND_NAME:
            saw_command_name = True
        remaining.append(p)
    return assignments, remaining


def get_pipeline_commands(
    node: TSNodeLike,
) -> tuple[list[TSNodeLike], list[bool]]:
    """Get (commands, stderr_flags) from pipeline.

    Uses node.children for pipe token detection.
    """
    commands: list[TSNodeLike] = []
    stderr_flags: list[bool] = []
    for c in node.children:
        if c.is_named:
            commands.append(c)
        elif c.type in (NT.PIPE, NT.PIPE_STDERR):
            stderr_flags.append(c.type == NT.PIPE_STDERR)
    return commands, stderr_flags


def get_pipeline_stages(
    node: TSNodeLike,
    redirects: Sequence[Redirect] = (),
) -> PipelineStages:
    """A pipeline's stages as bash reads them, whatever shape the parse
    gave them.

    The parser lets a redirect close over everything to its left
    up to the next pipe, so ``a && b | c < f | d`` parses as a pipeline
    whose first stage is ``redirected(a && b | c, < f)``, and ``! a < f
    | b`` as one whose first stage is ``redirected(! a, < f)``. Bash
    reads them as ``a && (b | c <f | d)`` and ``! (a <f | b)``: the
    redirect binds to the command it follows, the stages on both sides
    of it are one pipeline, a ``!`` negates all of it, and a list the
    parse pulled into the first stage runs ahead of the pipeline and
    decides whether it runs at all. This is the last-command chain the
    admission gate climbs for a redirect's target
    (``statement_redirects``), read in the direction the executor walks.

    Args:
        node (TSNodeLike): the pipeline node.
        redirects (Sequence[Redirect]): redirects hoisted over the whole
            pipeline, which bind to its last stage.
    """
    commands, stderr_flags = get_pipeline_commands(node)
    head = _pipeline_head(commands[0])
    stages = PipelineStages(
        commands=head.commands + tuple(commands[1:]),
        stderr_flags=head.stderr_flags + tuple(stderr_flags),
        redirects=head.redirects + tuple(() for _ in commands[1:]),
        negated=head.negated,
        lead=head.lead,
    )
    return _bind_last(stages, redirects)


def _bind_last(
    stages: PipelineStages, redirects: Sequence[Redirect]
) -> PipelineStages:
    """``stages`` with ``redirects`` bound to the last stage, after any it
    already carries (the inner ones come first in the source).

    Args:
        stages (PipelineStages): the stages to extend.
        redirects (Sequence[Redirect]): the redirects to bind.
    """
    if not redirects:
        return stages
    carried = stages.redirects[-1]
    last = (
        carried + tuple(redirects)
        if carried
        else tuple(with_own_redirects(stages.commands[-1], redirects))
    )
    return replace(stages, redirects=stages.redirects[:-1] + (last,))


def _pipeline_head(stage: TSNodeLike) -> PipelineStages:
    """The stages a pipeline's first element stands for.

    Only a redirected statement over a pipeline, a list or a negation is
    re-read; every other stage, a redirected command included, is one
    stage that runs as the node it is.

    Args:
        stage (TSNodeLike): the pipeline's first element.
    """
    single = PipelineStages(
        commands=(stage,), stderr_flags=(), redirects=((),)
    )
    body = stage
    hoisted: tuple[Redirect, ...] = ()
    if stage.type == NT.REDIRECTED_STATEMENT:
        found, parsed = get_redirects(stage)
        if found is None:
            return single
        body, hoisted = found, tuple(parsed)
    if body.type == NT.NEGATED_COMMAND:
        negated = get_negated_command(body)
        if negated is None:
            return single
        return PipelineStages(
            commands=(negated,),
            stderr_flags=(),
            redirects=(
                tuple(with_own_redirects(negated, hoisted)) if hoisted else (),
            ),
            negated=True,
        )
    if not hoisted:
        return single
    if body.type == NT.PIPELINE:
        return get_pipeline_stages(body, hoisted)
    if body.type == NT.LIST:
        left, op, right = get_list_parts(body)
        inner = (
            get_pipeline_stages(right, hoisted)
            if right.type == NT.PIPELINE
            else _bind_last(_pipeline_head(right), hoisted)
        )
        if inner.lead is None:
            return replace(inner, lead=(left, op, right))
    return single


def get_while_parts(
    node: TSNodeLike,
) -> tuple[list[TSNodeLike], list[TSNodeLike]]:
    """Get (test, body_commands) from while/until: every statement
    before the do_group, whose last one's status decides, and the
    do_group's children.
    """
    *test, body = node.named_children
    return test, list(body.named_children)


def get_for_parts(
    node: TSNodeLike,
) -> tuple[str, list[TSNodeLike] | None, list[TSNodeLike]]:
    """Get (variable, values, body_commands) from for/select.

    Returns the do_group's children list so multi-statement
    bodies are preserved. ``values`` is None for a header with no
    ``in`` (``for f do``), which loops over ``"$@"``.
    """
    nc = node.named_children
    values = (
        [c for c in nc[1:] if c.type not in (NT.DO_GROUP, NT.COMMENT)]
        if any(c.type == NT.IN for c in node.children)
        else None
    )
    return get_text(nc[0]), values, list(nc[-1].named_children)


def get_cfor_parts(
    node: TSNodeLike,
) -> tuple[list[list[TSNodeLike]], list[TSNodeLike]]:
    """Get ([init, cond, update], body_commands) from a C-style for.

    The expression slots are positional between the (( )) delimiters,
    separated by `;` tokens, and any of them may be empty (an empty
    list): `for ((;;))`. A slot holds every node and token the parser
    found in it, in order, commas and stray operators included, since
    bash evaluates the slot's text as one expression: `for ((a=1, i=0;
    ...))` assigns both, and `i<1 2` is an error, not two expressions.

    Args:
        node (TSNodeLike): the c_style_for_statement node.
    """
    exprs: list[list[TSNodeLike]] = [[], [], []]
    slot = 0
    inside = False
    body: list[TSNodeLike] = []
    for child in node.children:
        if child.type == NT.ARITH_OPEN:
            inside = True
            continue
        if child.type == NT.ARITH_CLOSE:
            inside = False
            continue
        if inside:
            if child.type == NT.SEMI:
                slot += 1
            elif slot < 3:
                exprs[slot].append(child)
            continue
        if child.type == NT.DO_GROUP:
            body = list(child.named_children)
    return exprs, body


def is_backgrounded(node: TSNodeLike) -> bool:
    """Whether a statement's terminator is ``&``.

    The parser puts the ``&`` beside the statement it ends, inside
    whatever body holds them both, so a body read as named children
    (every extractor above) never sees it. Asking the statement about
    its own next sibling is what lets a loop body, an if/case arm, a
    brace group and a function body launch the job the program loop
    launches for a top-level ``cmd &``.

    Args:
        node (TSNodeLike): a body statement.
    """
    sibling = node.next_sibling
    return sibling is not None and sibling.type == NT.BACKGROUND


REDIRECT_NODE_TYPES = frozenset(
    {
        NT.FILE_REDIRECT,
        NT.HERESTRING_REDIRECT,
    }
)

# RAW_STRING (single quotes) belongs here alongside STRING (double
# quotes): quoting a redirect target is purely syntactic in bash, so
# `> 'f'`, `> "f"` and `> f` name the same file. Omitting it left
# target_node None and target "", which silently redirected every
# single-quoted target to one phantom empty path instead of the file.
_TARGET_TYPES = frozenset(
    {
        NT.WORD,
        NT.CONCATENATION,
        NT.SIMPLE_EXPANSION,
        NT.EXPANSION,
        NT.COMMAND_SUBSTITUTION,
        NT.ARITHMETIC_EXPANSION,
        NT.STRING,
        NT.RAW_STRING,
        NT.ANSI_C_STRING,
        NT.TRANSLATED_STRING,
        NT.PROCESS_SUBSTITUTION,
    }
)

_INPUT_OPERATORS = frozenset(
    {NT.REDIRECT_IN, NT.REDIRECT_DUP_IN, NT.REDIRECT_CLOSE_IN}
)
_CLOSE_OPERATORS = frozenset({NT.REDIRECT_CLOSE_OUT, NT.REDIRECT_CLOSE_IN})
_DUP_OPERATORS = frozenset({NT.REDIRECT_STDERR, NT.REDIRECT_DUP_IN})
_BOTH_OPERATORS = frozenset({NT.REDIRECT_BOTH, NT.REDIRECT_BOTH_APPEND})
_REDIRECT_OPERATORS = (
    _INPUT_OPERATORS
    | _CLOSE_OPERATORS
    | _DUP_OPERATORS
    | _BOTH_OPERATORS
    | frozenset(
        {
            NT.REDIRECT_OUT,
            NT.REDIRECT_CLOBBER,
            NT.REDIRECT_APPEND,
            NT.REDIRECT_READWRITE,
        }
    )
)


def _parse_file_redirect(child: TSNodeLike) -> Redirect:
    """Parse a single file_redirect node into a Redirect.

    The operator token decides the shape and the explicit descriptor,
    when there is one, is kept as typed: `3<f` claims fd 3 and `<&3`
    duplicates from it (`shell/descriptors.py`). Three forms carry an
    int target: a dup (`2>&1`, `>&2`,
    `<&0`) names the descriptor it copies, a close (`>&-`, `<&-`)
    carries FD_CLOSE, and `&>` claims FD_BOTH.
    `2>&1` alone keeps the STDERR_TO_STDOUT kind the fd router keys on;
    every other output redirect is STDOUT or STDERR by the descriptor
    it claims.
    """
    target: str | int = ""
    target_node = None
    op: str | None = None
    dup_fd: int | None = None
    fd: int | None = None

    for c in child.children:
        if c.type == NT.FILE_DESCRIPTOR:
            fd = int(get_text(c))
        elif c.type in _REDIRECT_OPERATORS:
            op = c.type
        elif c.type == NT.NUMBER:
            dup_fd = int(get_text(c))

    for c in child.named_children:
        if c.type in _TARGET_TYPES:
            target = get_text(c)
            target_node = c
            break

    document = getattr(child, "heredoc", None)
    if document is not None:
        return Redirect(
            fd=0 if fd is None else fd,
            target=decode_text(document.body),
            target_node=target_node,
            kind=RedirectKind.HEREDOC,
            expand_vars=not document.quoted,
        )

    # `>&word` with a word rather than a number is bash's other spelling
    # of `&>word`, bare or on descriptor 1 (`1>&word` sends both streams
    # too, pinned on bash 5.2). On any other explicit descriptor bash
    # refuses it as `word: ambiguous redirect`, before the command runs
    # and before any file opens, so the parse keeps the word for the
    # message rather than turning `3>&foo` into a both-streams file.
    word_dup = (
        op == NT.REDIRECT_STDERR and dup_fd is None and target_node is not None
    )
    if word_dup and fd is not None and fd != FD_STDOUT:
        return Redirect(
            fd=fd,
            target=target,
            target_node=target_node,
            kind=RedirectKind.AMBIGUOUS,
        )
    if op in _BOTH_OPERATORS or word_dup:
        return Redirect(
            fd=FD_BOTH,
            target=target,
            target_node=target_node,
            kind=RedirectKind.STDOUT,
            append=op == NT.REDIRECT_BOTH_APPEND,
        )

    if fd is None:
        fd = (
            FD_STDIN
            if op in _INPUT_OPERATORS or op == NT.REDIRECT_READWRITE
            else FD_STDOUT
        )
    if op in _CLOSE_OPERATORS:
        target = FD_CLOSE
    elif op in _DUP_OPERATORS and dup_fd is not None:
        target = dup_fd

    if op == NT.REDIRECT_READWRITE:
        kind = RedirectKind.READWRITE
    elif op in _INPUT_OPERATORS:
        kind = RedirectKind.STDIN
    elif fd == FD_STDERR and target == FD_STDOUT and op == NT.REDIRECT_STDERR:
        kind = RedirectKind.STDERR_TO_STDOUT
    elif fd == FD_STDERR:
        kind = RedirectKind.STDERR
    else:
        kind = RedirectKind.STDOUT

    return Redirect(
        fd=fd,
        target=target,
        target_node=target_node,
        kind=kind,
        append=op == NT.REDIRECT_APPEND,
        clobber=op == NT.REDIRECT_CLOBBER,
    )


def _parse_herestring_redirect(child: TSNodeLike) -> Redirect:
    fd = next(
        (
            int(get_text(c))
            for c in child.named_children
            if c.type == NT.FILE_DESCRIPTOR
        ),
        0,
    )
    word = next(
        (
            candidate
            for candidate in child.named_children
            if candidate.type != NT.FILE_DESCRIPTOR
        ),
        None,
    )
    return Redirect(
        fd=fd,
        target=get_text(word) if word is not None else "",
        target_node=word,
        kind=RedirectKind.HERESTRING,
    )


def get_redirects(
    node: TSNodeLike,
) -> tuple[TSNodeLike | None, list[Redirect]]:
    """Parse all redirects from a redirected_statement.

    Returns (command, redirects); command is None for a bare redirect
    like `> file` (bash runs the empty command and applies redirects,
    creating/truncating the file).
    """
    nc = node.named_children
    command = nc[0] if nc and nc[0].type not in REDIRECT_NODE_TYPES else None
    redirects: list[Redirect] = []
    for child in nc if command is None else nc[1:]:
        if child.type == NT.FILE_REDIRECT:
            redirects.append(_parse_file_redirect(child))
        elif child.type == NT.HERESTRING_REDIRECT:
            redirects.append(_parse_herestring_redirect(child))

    if command is not None and command.type in (
        NT.COMMAND,
        NT.DECLARATION_COMMAND,
        NT.UNSET_COMMAND,
    ):
        redirects = [*command_redirects(command), *redirects]
        if command.type == NT.COMMAND and not get_parts(command):
            command = None
    return command, redirects


def command_redirects(node: TSNodeLike) -> list[Redirect]:
    """The redirects written among a simple command's words, in order:
    bash applies them wherever they stand (``> f echo hi``, ``cat <<< x``).

    Args:
        node (TSNodeLike): a command node.
    """
    redirects: list[Redirect] = []
    for child in node.named_children:
        if child.type == NT.FILE_REDIRECT:
            redirects.append(_parse_file_redirect(child))
        elif child.type == NT.HERESTRING_REDIRECT:
            redirects.append(_parse_herestring_redirect(child))
    return redirects


def with_own_redirects(
    command: TSNodeLike, redirects: Sequence[Redirect]
) -> list[Redirect]:
    """Redirects hoisted onto a command, after the ones written among its
    words: bash applies them in source order (``true && > a echo > b``).

    Args:
        command (TSNodeLike): the node the redirects bind to.
        redirects (Sequence[Redirect]): the redirects hoisted onto it.
    """
    own = command_redirects(command) if command.type == NT.COMMAND else []
    return [*own, *redirects]


def get_list_parts(
    node: TSNodeLike,
) -> tuple[TSNodeLike, str, TSNodeLike]:
    """Get (left, op, right) from list node."""
    left = node.named_children[0]
    right = node.named_children[1]
    op = None
    for c in node.children:
        if c.type in (NT.AND, NT.OR, NT.SEMI):
            op = c.type
            break
    assert op is not None
    return left, op, right


def _test_and_body(
    node: TSNodeLike,
) -> tuple[list[TSNodeLike], list[TSNodeLike]]:
    """Split an ``if`` or ``elif`` at its ``then``: the test statements
    before it, the rest after.

    Args:
        node (TSNodeLike): an if_statement or elif_clause.
    """
    cut = next(
        (c.start_byte for c in node.children if c.type == "then"),
        node.end_byte,
    )
    named = node.named_children
    return (
        [c for c in named if c.start_byte < cut],
        [c for c in named if c.start_byte >= cut],
    )


def get_if_branches(
    node: TSNodeLike,
) -> tuple[
    list[tuple[list[TSNodeLike], list[TSNodeLike]]], list[TSNodeLike] | None
]:
    """Get (branches, else_body) from if_statement.

    Each branch is (test, body_commands): the statements before its
    ``then``, whose last one's status decides, and those after it.
    else_body is also a list of nodes, or None.
    """
    test, rest = _test_and_body(node)
    branches: list[tuple[list[TSNodeLike], list[TSNodeLike]]] = [(test, [])]
    else_body: list[TSNodeLike] | None = None
    for c in rest:
        if c.type == NT.ELIF_CLAUSE:
            branches.append(_test_and_body(c))
        elif c.type == NT.ELSE_CLAUSE:
            else_body = list(c.named_children)
        else:
            branches[-1][1].append(c)
    return branches, else_body


def get_case_word(node: TSNodeLike) -> TSNodeLike:
    """Get the word being matched in case."""
    return node.named_children[0]


def get_case_items(
    node: TSNodeLike,
) -> list[tuple[list[TSNodeLike], list[TSNodeLike], str]]:
    """Get (pattern_nodes, body_statements, terminator) triples from case.

    Patterns are every named child before the arm's ``)``, kept as
    nodes so quoting survives to the matcher: 'a'), "$x") and $'a\\n')
    all mean literal text where a bare word keeps its globs live. An
    arm's body is every statement up to its terminator, so
    multi-statement arms (x) cmd1; cmd2;;) keep all commands. The
    terminator is one of ``;;`` (default/last arm), ``;&`` (fall through
    into the next arm's body unconditionally), or ``;;&`` (keep testing
    the remaining patterns).
    """
    items: list[tuple[list[TSNodeLike], list[TSNodeLike], str]] = []
    for c in node.named_children:
        if c.type == NT.CASE_ITEM:
            patterns: list[TSNodeLike] = []
            body: list[TSNodeLike] = []
            terminator = ";;"
            in_body = False
            for child in c.children:
                if child.type in (";;", ";&", ";;&"):
                    terminator = child.type
                elif child.type == ")":
                    in_body = True
                elif not child.is_named:
                    continue
                elif in_body:
                    body.append(child)
                else:
                    patterns.append(child)
            items.append((patterns, body, terminator))
    return items


def get_declaration_keyword(node: TSNodeLike) -> str:
    """Get keyword (export/local/declare) from declaration."""
    return node.children[0].type


def get_unset_args(node: TSNodeLike) -> list[str]:
    """Get every operand word of unset_command, keeping ``-f``/``-v``/``-n``.

    The leading option words are preserved so the handler can tell a
    function unset (``unset -f``) from a variable unset, and the operand
    span is split the way the shell does so a subscript target
    (``unset arr[1]``, quoted or not) stays one word. A redirect among
    the words is no operand.
    """
    operands = [
        c for c in node.children[1:] if c.type not in REDIRECT_NODE_TYPES
    ]
    if not operands:
        return []
    text = bytearray(node.text or b"")
    for child in node.children:
        if child.type in REDIRECT_NODE_TYPES:
            start = child.start_byte - node.start_byte
            end = child.end_byte - node.start_byte
            text[start:end] = b" " * (end - start)
    start = operands[0].start_byte - node.start_byte
    try:
        return shlex.split(decode_text(bytes(text[start:])))
    except ValueError:
        return [get_text(c) for c in operands if c.is_named]


def get_negated_command(node: TSNodeLike) -> TSNodeLike | None:
    """Get inner command from negated_command (! cmd); None for a bare
    ``!``, which negates the empty command."""
    return node.named_children[0] if node.named_children else None


def get_process_sub_direction(node: TSNodeLike) -> ProcessSubDirection | None:
    """Return the direction marker on a process_substitution node.

    `<(cmd)` is INPUT (inner stdout feeds our stdin), `>(cmd)` is OUTPUT
    (our stdout feeds inner stdin). Returns None if the open token is missing.
    """
    if not node.children:
        return None
    open_token = node.children[0].type
    if open_token == "<(":
        return ProcessSubDirection.INPUT
    if open_token == ">(":
        return ProcessSubDirection.OUTPUT
    return None


def input_substitution_redirect(node: TSNodeLike) -> Redirect | None:
    """Bash's single-file command substitution, measured against 5.2.37.

    Only a lone foreground ``< file`` (optionally ``0<``) reads input
    into the substitution. Extra redirects, commands, heredocs and
    descriptor duplication retain ordinary redirect-only semantics.

    Args:
        node (TSNodeLike): the parsed substitution body program.
    """
    if any(child.type == "&" for child in node.children):
        return None
    statements = [c for c in node.named_children if c.type != NT.COMMENT]
    if len(statements) != 1:
        return None
    statement = statements[0]
    if statement.type == NT.FILE_REDIRECT:
        command, redirects = None, [_parse_file_redirect(statement)]
    elif statement.type == NT.REDIRECTED_STATEMENT:
        command, redirects = get_redirects(statement)
    else:
        return None
    if command is not None or len(redirects) != 1:
        return None
    redirect = redirects[0]
    if (
        redirect.kind != RedirectKind.STDIN
        or redirect.fd != 0
        or isinstance(redirect.target, int)
    ):
        return None
    return redirect


def get_process_sub_body(node: TSNodeLike) -> str:
    """A process substitution's command text, with the heredoc bodies the
    line reads after it moved inside it.

    Args:
        node (TSNodeLike): the process_substitution node.
    """
    text = decode_text(
        getattr(node, "inlined", None)
        or getattr(node, "source_text", node.text)
        or b""
    )
    if text.startswith(("<(", ">(")) and text.endswith(")"):
        return text[2:-1]
    return text


def get_function_name(node: TSNodeLike) -> str:
    """Get function name."""
    return get_text(node.named_children[0])


def get_function_redirects(node: TSNodeLike) -> list[TSNodeLike]:
    """The redirects a function definition carries: its own, and those of
    a statement it is the body of (``f() { ...; } >o 2>&1``, whose second
    redirect the parser hangs on a redirected_statement around it).

    Args:
        node (TSNodeLike): the function_definition node.
    """
    redirects = [
        c for c in node.named_children if c.type in REDIRECT_NODE_TYPES
    ]
    outer = node.parent
    if (
        outer is not None
        and outer.type == NT.REDIRECTED_STATEMENT
        and outer.named_children[0].id == node.id
    ):
        redirects += [
            c
            for c in outer.named_children[1:]
            if c.type in REDIRECT_NODE_TYPES
        ]
    return redirects


def _syntax_end(node: TSNodeLike, offsets: Sequence[int]) -> int:
    """Where a node's own words end in the original source.

    A heredoc redirect ends at its delimiter word: the lowering folds the
    body into the redirect's span, and the body sits after whatever else
    the line goes on to say.

    Args:
        node (TSNodeLike): a node of the lowered tree.
        offsets (Sequence[int]): lowered byte to original byte.
    """
    doc = getattr(node, "heredoc", None)
    if doc is not None:
        return cast(int, doc.word_end)
    if node.children:
        return max(_syntax_end(child, offsets) for child in node.children)
    if node.end_byte > node.start_byte:
        return offsets[node.end_byte - 1] + 1
    return offsets[node.start_byte]


def get_function_source(node: TSNodeLike) -> str:
    """The definition's source, including redirects and heredoc bodies.

    Args:
        node (TSNodeLike): the function definition to persist.
    """
    parent = node.parent
    if parent is not None and parent.type == NT.REDIRECTED_STATEMENT:
        node = parent
    root = tree_root(node)
    if isinstance(node, ProgramNode):
        original = encode_text(node.program.original)
        offsets = node.program.offsets
    else:
        original = getattr(root, "source_text", root.text) or b""
        offsets = getattr(root, "offsets", tuple(range(len(original) + 1)))
    start = offsets[node.start_byte]
    end = _syntax_end(node, offsets)
    source = original[start:end]
    # A heredoc can follow the definition's closing brace and other commands.
    # Append only its body and delimiter, never those neighboring commands.
    documents: dict[int, int] = {}
    pending = [node]
    while pending:
        current = pending.pop()
        doc = getattr(current, "heredoc", None)
        if doc is not None and doc.body_start >= end:
            documents[doc.body_start] = doc.end
        pending.extend(current.named_children)
    if documents:
        source += b"\n" + b"".join(
            original[begin:stop] for begin, stop in sorted(documents.items())
        )
    return decode_text(source)


def parse_function(
    source: str, parse_fn: Callable[[str], TSNodeLike]
) -> FunctionBody:
    """Parse one stored definition inside the caller's owned parse scope.

    Args:
        source (str): portable function definition, including redirects.
        parse_fn (Callable[[str], TSNodeLike]): scope-owned parser.
    """
    root = parse_fn(source)
    nodes = [n for n in root.named_children if n.type != NT.COMMENT]
    if len(nodes) != 1:
        raise ValueError("stored function must contain one definition")
    node = nodes[0]
    if node.type == NT.REDIRECTED_STATEMENT:
        node = node.named_children[0]
    if node.type != NT.FUNCTION_DEFINITION:
        raise ValueError("stored function must contain one definition")
    return get_function_body(node)


def get_function_body(node: TSNodeLike) -> FunctionBody:
    """Get function body commands.

    Returns the compound_statement's children list so multi-statement
    bodies are preserved; any other compound command (``f() ( ... )``)
    is the one statement. The redirects a definition carries, its own
    and those of a statement it is the body of (``f() { ...; } >o
    2>&1``), apply at every call, as bash's do, so then the body is one
    statement: the group under them.

    Args:
        node (TSNodeLike): the function_definition node.
    """
    body = node.child_by_field_name("body")
    if body is None:
        raise ValueError("function definition has no body")
    redirects = get_function_redirects(node)
    if not redirects:
        return (
            list(body.named_children)
            if body.type == NT.COMPOUND_STATEMENT
            else [body]
        )
    parts = [body, *redirects]
    return [
        cast(
            TSNodeLike,
            SimpleNamespace(
                type=NT.REDIRECTED_STATEMENT,
                children=parts,
                named_children=parts,
                next_sibling=None,
                parent=None,
                id=node.id,
                text=node.text,
                start_byte=node.start_byte,
                end_byte=node.end_byte,
                start_point=node.start_point,
                end_point=node.end_point,
            ),
        )
    ]
