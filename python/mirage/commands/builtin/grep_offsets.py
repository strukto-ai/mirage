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

import re
from collections.abc import Sequence

from mirage.commands.builtin.utils.pcre import match_start, match_text
from mirage.shell.bytes import encode_text
from mirage.shell.helpers import byte_offset


def line_offsets(lines: Sequence[str]) -> list[int]:
    """Byte offset of each line's own first byte within the whole input.

    A line iterator strips the terminator, so the accumulator advances by
    one more than the line's own length. The extra byte past the last line
    is never read, which is why a file with no final newline still reports
    a correct offset for every line it does have. The lines must have come
    from ``decode_text``; a lossily decoded one cannot be counted back.

    Args:
        lines (Sequence[str]): the input's lines, terminators stripped.
    """
    offsets: list[int] = []
    position = 0
    for line in lines:
        offsets.append(position)
        position += len(encode_text(line)) + 1
    return offsets


def rust_matches(pat: re.Pattern[str], line: str) -> list[tuple[int, str]]:
    """Every match of a pattern in a line, found as ripgrep finds them.

    ripgrep iterates matches the way Rust's regex crate does: after an
    empty match the search resumes one character on, and an empty match
    where the previous match ended is skipped. Python's ``finditer`` keeps
    that one, so ``b*`` on ``abc`` is four matches to it and three to
    ripgrep; ``search`` from a position steps the way Rust does.

    Args:
        pat (re.Pattern[str]): the compiled pattern.
        line (str): the line, terminator stripped.

    Returns:
        list[tuple[int, str]]: each match's character index and text.
    """
    matches: list[tuple[int, str]] = []
    pos = 0
    last_end = -1
    while pos <= len(line):
        m = pat.search(line, pos)
        if m is None:
            break
        if m.start() == m.end():
            pos = m.end() + 1
            if m.end() == last_end:
                continue
        else:
            pos = m.end()
        last_end = m.end()
        matches.append((match_start(m), match_text(m)))
    return matches


def rg_pieces(pat: re.Pattern[str], line: str) -> list[tuple[int, str]]:
    """What ripgrep's -o prints for one line, one piece per output line.

    Each match, empty ones included (``rust_matches``), or the whole line
    when nothing in it matches, which is how ripgrep prints an inverted
    selection and a context line under -o (14.1.1).

    Args:
        pat (re.Pattern[str]): the compiled pattern.
        line (str): the line, terminator stripped.

    Returns:
        list[tuple[int, str]]: each piece's character index and text.
    """
    return rust_matches(pat, line) or [(0, line)]


class MatchOffsets:
    """Incremental byte offsets for increasing match indices on one line."""

    def __init__(self, line_start: int, line: str) -> None:
        self._position = line_start
        self._line = line
        self._index = 0

    def at(self, index: int) -> int:
        self._position += byte_offset(
            self._line[self._index : index], index - self._index
        )
        self._index = index
        return self._position


def prefix_of(
    number: int | None, offset: int | None, selected: bool = True
) -> str:
    """grep's line-number and byte-offset fields, in GNU's fixed order.

    GNU prints FILENAME, then LINE NUMBER, then BYTE OFFSET, whatever
    order the flags were given in, and picks the separator once per line:
    a context line renders every field with ``-`` where a selected line
    uses ``:``.

    Args:
        number (int | None): the line number, None when -n is off.
        offset (int | None): the byte offset, None when -b is off.
        selected (bool): False for a context line.
    """
    separator = ":" if selected else "-"
    fields = ""
    if number is not None:
        fields += f"{number}{separator}"
    if offset is not None:
        fields += f"{offset}{separator}"
    return fields
