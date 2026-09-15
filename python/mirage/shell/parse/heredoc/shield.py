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

from mirage.shell.bytes import encode_text
from mirage.shell.parse.heredoc.body import heredoc_bodies
from mirage.shell.parse.heredoc.constants import (ALTERNATE_FILLER, BACKSLASH,
                                                  DASH_ARROW, ESCAPE_PARTNERS,
                                                  FILLER, HEREDOC_START,
                                                  LINE_BLANKS)
from mirage.shell.parse.heredoc.delimiter import clean_delimiter
from mirage.shell.parse.heredoc.types import HeredocOperator
from mirage.shell.types import TSNodeLike


def heredoc_operators(root: TSNodeLike) -> list[HeredocOperator]:
    """Every heredoc operator under ``root``, in source order.

    ERROR subtrees are walked too: a body the lexer mangled badly enough
    leaves no heredoc_redirect behind, but its start token survives.
    These are hints; the source reader validates delimiter word bounds.

    Args:
        root (TSNodeLike): the parsed tree.
    """
    found: list[HeredocOperator] = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != HEREDOC_START:
            continue
        delimiter = clean_delimiter((node.text or b"").decode())
        previous = node.prev_sibling
        found.append(
            HeredocOperator(word_start=node.start_byte,
                            word_end=node.end_byte,
                            delimiter=delimiter,
                            allows_indent=previous is not None
                            and previous.type == DASH_ARROW))
    found.sort(key=lambda operator: operator.word_start)
    return found


def first_content_line(data: bytes, body_start: int,
                       body_end: int) -> int | None:
    """Offset of the first body line that is not empty.

    Args:
        data (bytes): the shell source.
        body_start (int): byte offset of the body's first line.
        body_end (int): byte offset of the terminator line.
    """
    position = body_start
    while position < body_end:
        newline = data.find(b"\n", position, body_end)
        line_end = body_end if newline < 0 else newline
        if line_end > position:
            return position
        position = line_end + 1
    return None


def terminator_lookalikes(data: bytes, span: tuple[int, int],
                          delimiter: bytes) -> list[int]:
    """One byte per body line the scanner would close the body at.

    tree-sitter-bash compares a line's first ``len(delimiter)`` bytes,
    after any leading blanks, with the delimiter and stops there, so
    ``EOFX``, ``EOF;`` and `` EOF`` all end a body that bash reads on
    through: bash wants the whole line to be the delimiter, leading tabs
    aside under ``<<-``. Writing a letter over one byte of that prefix
    keeps the scanner in the body. A ``$``, backtick or backslash is
    passed over, so an expansion opening the line keeps its shape in the
    masked copy.

    Args:
        data (bytes): the shell source.
        span (tuple[int, int]): the body's ``(start, end)``.
        delimiter (bytes): the cleaned delimiter.

    Returns:
        list[int]: the offset to mask on each such line, in source order.
    """
    offsets: list[int] = []
    position = span[0]
    while position < span[1]:
        newline = data.find(b"\n", position, span[1])
        line_end = span[1] if newline < 0 else newline
        start = position
        while start < line_end and data[start] in LINE_BLANKS:
            start += 1
        if data.startswith(delimiter, start, line_end):
            masked = next((offset
                           for offset in range(start, start + len(delimiter))
                           if data[offset] not in ESCAPE_PARTNERS), None)
            if masked is not None:
                offsets.append(masked)
        position = line_end + 1
    return offsets


def protected_source(data: bytes, root: TSNodeLike) -> bytes | None:
    """``data`` with every heredoc body made lexable as bash reads it.

    tree-sitter-bash decides where a heredoc body starts from the byte
    that follows the operator line, and gets it wrong for two shapes bash
    reads fine: leading whitespace is skipped, and a line opening with a
    backslash is lexed as more words of the operator line, so the line is
    lost from the body and, worse, lands in whatever construct was open
    (``tr a-z A-Z \\first``), or breaks the parse outright once it holds
    an apostrophe or a ``;``. Replacing that one byte (and the byte a
    backslash escapes, so ``\\$v`` cannot surface as an expansion) with a
    plain letter makes the scanner start the body exactly where bash
    does, without moving a single offset; the caller then reads the body
    back out of the untouched source. An empty line before the first
    kept one has no byte to mask without moving a row, so those are left
    to body_prefix. It also ends a body one line early, at any line that
    merely opens with the delimiter (see terminator_lookalikes); one
    byte of each such line is masked the same way. Bodies are read
    innermost-first per line, the order the parser's source keeps them
    in (see relayout).

    Args:
        data (bytes): the shell source.
        root (TSNodeLike): the tree parsed from ``data``.

    Returns:
        bytes | None: the protected source, or None when every body
        already lexes as bash reads it.
    """
    out = bytearray(data)
    changed = False
    operators = heredoc_operators(root)
    spans = heredoc_bodies(data, operators, nested=True)
    for operator, span in zip(operators, spans):
        if span is None:
            continue
        for offset in terminator_lookalikes(data, span,
                                            encode_text(operator.delimiter)):
            out[offset] = (ALTERNATE_FILLER
                           if data[offset] == FILLER else FILLER)
            changed = True
        line = first_content_line(data, *span)
        if line is None:
            continue
        first = data[line]
        if first not in LINE_BLANKS and first != BACKSLASH:
            continue
        filler = (ALTERNATE_FILLER
                  if operator.delimiter.startswith(chr(FILLER)) else FILLER)
        out[line] = filler
        changed = True
        if (first == BACKSLASH and line + 1 < span[1]
                and data[line + 1] in ESCAPE_PARTNERS):
            out[line + 1] = filler
    return bytes(out) if changed else None


def same_shape(left: TSNodeLike, right: TSNodeLike) -> bool:
    """Whether two trees agree on every node's type and byte span.

    Args:
        left (TSNodeLike): one tree's root.
        right (TSNodeLike): the other tree's root.
    """
    stack = [(left, right)]
    while stack:
        a, b = stack.pop()
        if (a.type != b.type or a.start_byte != b.start_byte
                or a.end_byte != b.end_byte or a.child_count != b.child_count):
            return False
        stack.extend(zip(a.children, b.children))
    return True
