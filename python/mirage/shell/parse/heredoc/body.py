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

from collections.abc import Sequence

from mirage.shell.bytes import encode_text
from mirage.shell.parse.heredoc.line import operator_line_end
from mirage.shell.parse.heredoc.types import HeredocOperator


def terminator_line(data: bytes, body_start: int, delimiter: bytes,
                    allows_indent: bool) -> int | None:
    """Offset where the line closing the body starts.

    Bash ends a body at the first line that equals the delimiter, with
    leading tabs stripped first under ``<<-``.

    Args:
        data (bytes): the shell source.
        body_start (int): byte offset of the body's first line.
        delimiter (bytes): the cleaned delimiter.
        allows_indent (bool): whether the operator was ``<<-``.

    Returns:
        int | None: the line's offset, or None when no line closes the
        body.
    """
    position = body_start
    while position <= len(data):
        newline = data.find(b"\n", position)
        line_end = len(data) if newline < 0 else newline
        line = data[position:line_end]
        if allows_indent:
            line = line.lstrip(b"\t")
        if line == delimiter:
            return position
        if newline < 0:
            return None
        position = newline + 1
    return None


def next_line(data: bytes, line_start: int) -> int | None:
    """Offset of the line after the one starting at ``line_start``.

    Args:
        data (bytes): the shell source.
        line_start (int): byte offset of a line.

    Returns:
        int | None: the following line's offset, or None when this line
        is the last one and has no newline.
    """
    newline = data.find(b"\n", line_start)
    return None if newline < 0 else newline + 1


def heredoc_bodies(data: bytes, operators: Sequence[HeredocOperator], *,
                   nested: bool) -> list[tuple[int, int] | None]:
    """The body span of every operator, read the way bash reads them.

    Bash gathers bodies at the newline that ends an operator's logical
    line, one after another in the order the operators appear on it, so
    the second body of ``cat <<A <<B`` starts on the line after ``A``'s
    terminator. A body is every line strictly between where it starts
    and the line holding its delimiter; when no line holds it, the body
    runs to the end of the source, which is how bash reads it too, under
    a warning that names the delimiter it wanted. That makes the span a
    property of the source text, not of any token the parser produced.
    An operator that lies inside an earlier body is text, not syntax,
    and one whose turn comes once the source has run out has no body.

    Args:
        data (bytes): the shell source.
        operators (Sequence[HeredocOperator]): the operators, in any
            order.
        nested (bool): whether one line's bodies stand innermost-first,
            the order tree-sitter-bash's grammar closes them in, rather
            than in the order bash gathers them. The source the parser
            reads is kept in that order (see relayout), so the shield
            and body_prefix read it, while relayout reads the typed
            source as bash does. A line with one operator reads the same
            either way.

    Returns:
        list[tuple[int, int] | None]: ``(body_start, body_end)`` for
        each operator, in the order given; None when the body never
        starts.
    """
    spans: list[tuple[int, int] | None] = [None] * len(operators)
    bodies: list[tuple[int, int]] = []
    lines: dict[int, list[int]] = {}
    for index in sorted(range(len(operators)),
                        key=lambda position: operators[position].word_start):
        line_end = operator_line_end(data, operators[index].word_end)
        if line_end is not None:
            lines.setdefault(line_end, []).append(index)
    for line_end, members in lines.items():
        cursor: int | None = line_end + 1
        for index in reversed(members) if nested else members:
            operator = operators[index]
            if any(begin <= operator.word_start < end
                   for begin, end in bodies):
                continue
            if cursor is None:
                continue
            body_end = terminator_line(data, cursor,
                                       encode_text(operator.delimiter),
                                       operator.allows_indent)
            if body_end is None:
                body_end = len(data)
            spans[index] = (cursor, body_end)
            bodies.append((cursor, body_end))
            cursor = next_line(data, body_end)
    return spans
