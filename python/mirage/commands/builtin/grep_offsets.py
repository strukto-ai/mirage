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

from mirage.shell.helpers import byte_offset


def decode_line(raw: bytes) -> str:
    """The input's bytes as text a byte offset can be counted back out of.

    The whole family holds a line as text, so every byte offset it prints
    is a character index converted back. That only answers GNU's number
    when the conversion round-trips, which ``errors="replace"`` does not:
    one invalid byte becomes U+FFFD, three bytes wide, so a `-b` offset
    past it ran ahead (`rg -b a` over `\\xff\\na\\n` answered 4 where GNU
    says 2) and a `-bo` match offset inside such a line ran ahead too. A
    surrogate escape stands for exactly one byte, which is the convention
    ``byte_offset`` in ``shell/helpers.py`` already assumes and the twin
    of ``decodeLine`` in ``grep_offsets.ts``.

    Args:
        raw (bytes): the bytes to read as text.
    """
    return raw.decode("utf-8", errors="surrogateescape")


def encode_line(text: str) -> bytes:
    """Text back to the bytes ``decode_line`` read it from.

    Args:
        text (str): text that may carry surrogate-escaped bytes.
    """
    return text.encode("utf-8", errors="surrogateescape")


def printable(text: str) -> str:
    """One output line, with every smuggled byte back to U+FFFD.

    A scan that answers in ``list[str]`` hands its lines to
    ``format_records``, which encodes strictly, so a surrogate escape
    would raise there rather than print. This is the one place the
    round-trip is deliberately given up, and it gives up exactly what
    ``errors="replace"`` used to give up, so what reaches stdout is
    unchanged; only the offsets computed before it are now right. A
    streaming path never needs it, because it encodes with
    ``encode_line`` and prints the bytes GNU prints.

    Args:
        text (str): a rendered output line.
    """
    return encode_line(text).decode("utf-8", errors="replace")


def line_offsets(lines: Sequence[str]) -> list[int]:
    """Byte offset of each line's own first byte within the whole input.

    A line iterator strips the terminator, so the accumulator advances by
    one more than the line's own length. The extra byte past the last line
    is never read, which is why a file with no final newline still reports
    a correct offset for every line it does have. The lines must have come
    from ``decode_line``; a lossily decoded one cannot be counted back.

    Args:
        lines (Sequence[str]): the input's lines, terminators stripped.
    """
    offsets: list[int] = []
    position = 0
    for line in lines:
        offsets.append(position)
        position += len(encode_line(line)) + 1
    return offsets


def match_offset(line_start: int, line: str, index: int) -> int:
    """Where a match begins in bytes, given its character index.

    The pattern engine reports a character index because both hosts hold a
    line as text; GNU reports a byte count and reports the same number
    under C and C.utf8, so the index is converted rather than printed.

    Args:
        line_start (int): the line's own byte offset.
        line (str): the line the index is into.
        index (int): a character index into that line.
    """
    return line_start + byte_offset(line, index)


def prefix_of(number: int | None,
              offset: int | None,
              selected: bool = True) -> str:
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
