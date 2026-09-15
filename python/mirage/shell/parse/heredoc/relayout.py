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

from collections.abc import Mapping, Sequence

import tree_sitter

from mirage.shell.parse.heredoc import constants
from mirage.shell.parse.heredoc.body import heredoc_bodies, next_line
from mirage.shell.parse.heredoc.delimiter import ansi_c_end
from mirage.shell.parse.heredoc.line import (construct_closer, construct_end,
                                             operator_line_end, quote_end,
                                             reserved_word)
from mirage.shell.parse.heredoc.shield import heredoc_operators
from mirage.shell.parse.heredoc.types import HeredocOperator, Terminator


def delimiter_break(token: str) -> int | None:
    """Index of the first unquoted metacharacter inside a delimiter token.

    tree-sitter-bash reads an unquoted delimiter up to the next blank, so
    ``cat <<EOF; echo x`` gets the token ``EOF;`` and then waits for a
    line reading ``EOF;``, while bash ends the word at the ``;``. Quotes
    and backslashes count the way the word is read: ``'EOF;'`` really
    does name ``EOF;`` and ``E'O;'F;`` breaks at its last byte.

    Args:
        token (str): the heredoc_start token as typed.

    Returns:
        int | None: where the word ends, or None when the token is one
        word (a token opening with a metacharacter is left to the
        parser's own refusal).
    """
    quote: str | None = None
    index = 0
    while index < len(token):
        char = token[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif quote == '"':
            if char == '"':
                quote = None
            elif char == "\\":
                index += 1
        elif char == "$" and token[index + 1:index + 2] == "'":
            index = ansi_c_end(token, index + 2)
        elif char in ("'", '"'):
            quote = char
        elif char == "\\":
            index += 1
        elif char in constants.WORD_BREAKERS:
            return index or None
        index += 1
    return None


def word_breaks(root: tree_sitter.Node) -> list[int]:
    """Byte offsets where a heredoc_start token runs past its word.

    Each is where a blank goes so the parser ends the delimiter where
    bash does. ERROR subtrees are walked too, since the mis-read token
    usually leaves the rest of the line unparseable.

    Args:
        root (tree_sitter.Node): the parsed tree.
    """
    offsets: list[int] = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != constants.HEREDOC_START:
            continue
        token = (node.text or b"").decode()
        index = delimiter_break(token)
        if index is not None:
            offsets.append(node.start_byte + len(token[:index].encode()))
    return offsets


def line_terminators(data: bytes, start: int, end: int) -> list[Terminator]:
    """The statement terminators between ``start`` and ``end`` of a line.

    Read the way operator_line_end reads the line: a backslash escapes
    the next byte, quotes hide their contents, ``$(``, ``<(``, ``>(``
    and ``${`` run to their close, and a ``#`` opening a word ends the
    search. A bare ``(`` opens a subshell or arithmetic command that
    moves whole, so it runs to its balancing paren too. A ``)`` that
    ends a case pattern terminates nothing, so an open ``case`` is
    counted and its patterns' parens passed over; the ``;;`` closing an
    item is a terminator, since bash reads one at the start of a line.

    Args:
        data (bytes): the shell source.
        start (int): byte offset to read from, past the delimiter word.
        end (int): byte offset of the newline ending the logical line.
    """
    found: list[Terminator] = []
    index = start
    cases = 0
    while index < end:
        byte = data[index]
        closer = construct_closer(data, index, False)
        if byte == constants.BACKSLASH:
            index += 2
            continue
        if byte in constants.QUOTE_OPENERS:
            closed = quote_end(data, index)
        elif closer is not None:
            closed = construct_end(data, index, closer)
        elif byte == constants.OPEN_PAREN:
            closed = construct_end(data, index, constants.CLOSE_PAREN)
        else:
            closed = None
            if (byte == constants.HASH
                    and data[index - 1] in constants.COMMENT_PRECEDERS):
                break
            if reserved_word(data, index, constants.CASE):
                cases += 1
                index += len(constants.CASE)
                continue
            if cases and reserved_word(data, index, constants.ESAC):
                cases -= 1
                index += len(constants.ESAC)
                continue
            if byte == constants.CLOSE_PAREN and cases:
                index += 1
                continue
            kept = next((token for token in constants.KEPT_TERMINATORS
                         if data.startswith(token, index)), None)
            if kept is not None:
                found.append(Terminator(start=index, resume=index))
                index += len(kept)
                continue
            if byte == constants.SEMICOLON:
                found.append(Terminator(start=index, resume=index + 1))
            index += 1
            continue
        if closed is None:
            break
        index = closed
    return found


def _block(data: bytes, span: tuple[int, int]) -> bytes:
    """The body at ``span`` with its terminator line, newline-ended.

    Args:
        data (bytes): the shell source.
        span (tuple[int, int]): the body's ``(start, end)``.
    """
    block = data[span[0]:block_end(data, span)]
    return block if block.endswith(b"\n") else block + b"\n"


def block_end(data: bytes, span: tuple[int, int]) -> int:
    """Offset just past the terminator line of the body at ``span``.

    Args:
        data (bytes): the shell source.
        span (tuple[int, int]): the body's ``(start, end)``.
    """
    following = next_line(data, span[1])
    return len(data) if following is None else following


def relaid_line(data: bytes, operators: Sequence[HeredocOperator],
                bodies: Mapping[int, tuple[int, int]], members: Sequence[int],
                line_end: int) -> bytes:
    """``data`` with one operator line laid out as the grammar needs it.

    The line is cut at the first terminator after each operator, so a
    statement typed after the operator moves to the line after its body
    (``cat <<EOF; echo x`` becomes ``cat <<EOF``, the body, ``echo x``),
    and each segment's bodies follow that segment innermost-first, the
    reverse of the order bash gathers them, because the grammar nests
    every later statement of a line inside the earlier redirect and
    closes the innermost body first.

    Args:
        data (bytes): the shell source, in bash's order.
        operators (Sequence[HeredocOperator]): every operator of the tree.
        bodies (Mapping[int, tuple[int, int]]): the bash body span of
            every operator that has one, by index into ``operators``.
        members (Sequence[int]): indices of the operators on this line,
            in source order, every one in ``bodies``.
        line_end (int): byte offset of the newline ending the line.
    """
    terminators = line_terminators(data, operators[members[0]].word_end,
                                   line_end)
    cuts: list[Terminator] = []
    for index in members:
        word_end = operators[index].word_end
        cut = next((t for t in terminators if t.start >= word_end), None)
        if cut is not None and cut not in cuts:
            cuts.append(cut)
    segments: list[list[int]] = [[] for _ in range(len(cuts) + 1)]
    for index in members:
        word_end = operators[index].word_end
        position = next(
            (k for k, cut in enumerate(cuts) if cut.start >= word_end),
            len(cuts))
        segments[position].append(index)
    pieces = [data[:cuts[0].start if cuts else line_end]]
    for position, segment in enumerate(segments):
        pieces.append(b"\n")
        for index in reversed(segment):
            pieces.append(_block(data, bodies[index]))
        if position < len(cuts):
            tail_end = (cuts[position + 1].start if position +
                        1 < len(cuts) else line_end)
            pieces.append(data[cuts[position].resume:tail_end])
    pieces.append(data[max(block_end(data, bodies[i]) for i in members):])
    return b"".join(pieces)


def relayout(root: tree_sitter.Node, data: bytes) -> bytes | None:
    """``data`` rewritten so tree-sitter-bash reads its heredocs as bash does.

    The grammar keeps everything after a heredoc operator, up to its body,
    inside the redirect, so two shapes bash accepts do not parse: a
    statement terminator on the operator line (``cat <<EOF; echo x``,
    ``(cat <<EOF)``, a ``;;`` closing a case item), and two heredocs on
    one line whose bodies follow in source order (``cat <<A && cat <<B``
    with ``A``'s body first, which is what bash gathers). Both are a
    matter of where the bytes sit, so the source is laid out the way the
    grammar needs it and the same bytes reach the same commands: a tail
    moves to the line after the bodies it was typed before, and a line's
    bodies stand innermost-first. Bash reads ``;`` and a newline alike,
    so the rewritten source says what the typed one did; the one thing
    that moves is the row a moved statement runs on. Bodies are read from
    the typed source as bash gathers them; a body no line closes runs to
    the end of the source and nothing can be moved past it, so such a
    tree is left alone.

    Args:
        root (tree_sitter.Node): the tree parsed from ``data``.
        data (bytes): the shell source as typed.

    Returns:
        bytes | None: the rewritten source, or None when the layout
        already is the grammar's.
    """
    operators = heredoc_operators(root)
    bodies: dict[int, tuple[int, int]] = {}
    lines: dict[int, list[int]] = {}
    for index, span in enumerate(heredoc_bodies(data, operators,
                                                nested=False)):
        if span is None:
            continue
        if span[1] >= len(data):
            return None
        line_end = operator_line_end(data, operators[index].word_end)
        if line_end is not None:
            bodies[index] = span
            lines.setdefault(line_end, []).append(index)
    out = data
    for line_end in sorted(lines, reverse=True):
        out = relaid_line(out, operators, bodies, lines[line_end], line_end)
    return None if out == data else out
