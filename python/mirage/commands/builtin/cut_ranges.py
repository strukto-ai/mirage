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
from collections.abc import AsyncIterator
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.strtol import bounded_decimal
from mirage.commands.quote import quote_text
from mirage.commands.spec.usage import usage_hint
from mirage.io.async_line_iterator import AsyncLineIterator

_OPEN_END = 2**31 - 1
_BLANKS = re.compile(r"[ \t]+")
_CUT_TRY = usage_hint("cut")
# GNU 9.7 refuses a number at or past 2**64 - 1, quoting its digits as
# typed: `-f 18446744073709551614` is accepted, `-f 0018446744073709551615`
# reports "field number '0018446744073709551615' is too large".
_TOO_LARGE = 2**64 - 1
# What may sit between two list elements: a comma, a space or a TAB.
# NOT a newline, which is an invalid character here -- `cut -f $'1\n2'`
# is refused and quotes `'\n2'`, where `-f '1\t2'` selects fields 1 and
# 2. Probed over all 255 bytes: the only separators are 0x09, 0x20 and
# 0x2c, and every other non-digit non-dash byte is an invalid field
# value. Ground truth NL3-G.
_SEPARATORS = frozenset(", \t")


@dataclass(frozen=True, slots=True)
class _ListWords:
    value: str
    span: str
    zero: str
    large: str


# GNU words the two modes differently and never shares a string between
# them; only "invalid decreasing range" and "invalid range with no
# endpoint: -" carry no mode noun.
_FIELD_WORDS = _ListWords(
    "invalid field value",
    "invalid field range",
    "fields are numbered from 1",
    "field number",
)
# The two range strings are worded differently from each other on
# purpose: the position one joins the nouns with a slash, the range one
# spells out " or ". Both are byte-exact against coreutils 9.4.
_POSITION_WORDS = _ListWords(
    "invalid byte/character position",
    "invalid byte or character range",
    "byte/character positions are numbered from 1",
    "byte/character offset",
)


def _cut_error(message: str) -> ValueError:
    return ValueError(f"cut: {message}\n{_CUT_TRY}")


def _read_bound(
    spec: str, start: int, words: _ListWords
) -> tuple[int | None, int]:
    # The bound's value (None when no digit was typed) and where its
    # digits end.
    end = start
    while end < len(spec) and "0" <= spec[end] <= "9":
        end += 1
    if end == start:
        return None, end
    typed = spec[start:end]
    value = bounded_decimal(typed, _TOO_LARGE)
    if value is None:
        raise _cut_error(f"{words.large} '{quote_text(typed)}' is too large")
    return value, end


def _closed_element(
    low: int | None, is_range: bool, high: int | None, words: _ListWords
) -> tuple[int, int]:
    if not is_range:
        if not low:
            raise _cut_error(words.zero)
        return low, low
    if low is None and high is None:
        raise _cut_error("invalid range with no endpoint: -")
    first = 1 if low is None else low
    if high is None:
        return first, _OPEN_END
    if high < first:
        raise _cut_error("invalid decreasing range")
    return first, high


def parse_ranges(spec: str, mode: str) -> list[tuple[int, int]]:
    """Read a `-b`/`-c`/`-f` list into (first, last) pairs, as typed.

    Each element is `N`, `N-M`, `N-` or `-M`, and elements are split by
    a comma, a space or a TAB; an empty element counts as position 0,
    which is why `-f '2 '`, `-f 1,` and `-f ''` all report "numbered
    from 1". The first refusal met reading left to right wins, so
    `-f 0,x` is the zero message while `-f 0x` names `'x'`, and a low
    bound of 0 is refused at its dash (`-f 0-x` is the zero message
    too). A refused character quotes the rest of the spec from there:
    `-f 2-3x` and `-f 1,2x` both report `'x'`, `-f abc` reports
    `'abc'`. `-b` and `-c` differ from each other only in wording,
    which GNU keeps distinct from `-f`'s.

    Args:
        spec (str): the list as typed.
        mode (str): "bytes", "characters" or "fields".

    Returns:
        list[tuple[int, int]]: one closed pair per element; an open
        end is `_OPEN_END`.

    Raises:
        ValueError: the two stderr lines GNU prints, without the final
            newline.
    """
    words = _FIELD_WORDS if mode == "fields" else _POSITION_WORDS
    ranges: list[tuple[int, int]] = []
    cursor = 0
    while True:
        low, cursor = _read_bound(spec, cursor, words)
        is_range = spec.startswith("-", cursor)
        high = None
        if is_range:
            if low == 0:
                raise _cut_error(words.zero)
            high, cursor = _read_bound(spec, cursor + 1, words)
            if spec.startswith("-", cursor):
                raise _cut_error(words.span)
        if cursor < len(spec) and spec[cursor] not in _SEPARATORS:
            raise _cut_error(f"{words.value} '{quote_text(spec[cursor:])}'")
        ranges.append(_closed_element(low, is_range, high, words))
        if cursor == len(spec):
            return ranges
        cursor += 1


def _select_positions(
    ranges: list[tuple[int, int]], n: int, complement: bool
) -> list[int]:
    in_set: set[int] = set()
    for lo, hi in ranges:
        start = max(1, lo)
        end = min(hi, n)
        for position in range(start, end + 1):
            in_set.add(position)
    if complement:
        return [
            position for position in range(1, n + 1) if position not in in_set
        ]
    return [position for position in range(1, n + 1) if position in in_set]


def _join_position_groups(
    parts: list[bytes], positions: list[int], output_delimiter: bytes | None
) -> bytes:
    if not positions:
        return b""
    groups: list[bytes] = []
    group = bytearray(parts[positions[0] - 1])
    previous = positions[0]
    for position in positions[1:]:
        if position != previous + 1:
            groups.append(bytes(group))
            group = bytearray()
        group.extend(parts[position - 1])
        previous = position
    groups.append(bytes(group))
    return (output_delimiter or b"").join(groups)


def _cut_bytes(
    rec: bytes,
    ranges: list[tuple[int, int]],
    complement: bool,
    no_partial: bool,
    output_delimiter: bytes | None,
) -> bytes:
    positions = _select_positions(ranges, len(rec), complement)
    if not no_partial:
        return _join_position_groups(
            [bytes((byte,)) for byte in rec], positions, output_delimiter
        )
    selected = set(positions)
    parts: list[bytes] = []
    part_positions: list[int] = []
    offset = 0
    for char in rec.decode(errors="replace"):
        encoded = char.encode()
        end = offset + len(encoded)
        if end in selected:
            parts.append(rec[offset:end])
            part_positions.append(offset + 1)
        offset = end
    if output_delimiter is None:
        return b"".join(parts)
    groups: list[bytes] = []
    for index, part in enumerate(parts):
        if index == 0 or part_positions[index] != (
            part_positions[index - 1] + len(parts[index - 1])
        ):
            groups.append(part)
        else:
            groups[-1] += part
    return output_delimiter.join(groups)


def _cut_record(
    rec: bytes,
    ranges: list[tuple[int, int]],
    mode: str,
    delimiter: str,
    complement: bool,
    only_delimited: bool,
    whitespace: str | None,
    no_partial: bool,
    output_delimiter: str | None,
) -> bytes | None:
    output_bytes = (
        output_delimiter.encode() if output_delimiter is not None else None
    )
    if mode == "bytes":
        return _cut_bytes(rec, ranges, complement, no_partial, output_bytes)
    text = rec.decode(errors="replace")
    if mode == "characters":
        positions = _select_positions(ranges, len(text), complement)
        parts = [char.encode() for char in text]
        return _join_position_groups(parts, positions, output_bytes)
    if whitespace is not None:
        has_delimiter = _BLANKS.search(text) is not None
        source = text.strip(" \t") if whitespace == "trimmed" else text
        fields = _BLANKS.split(source)
        default_output = "\t"
    else:
        has_delimiter = delimiter in text
        fields = text.split(delimiter)
        default_output = delimiter
    if not has_delimiter:
        return None if only_delimited else rec
    if whitespace == "trimmed" and source == "" and only_delimited:
        return None
    positions = _select_positions(ranges, len(fields), complement)
    separator = (
        output_delimiter if output_delimiter is not None else default_output
    )
    return separator.join(
        fields[position - 1] for position in positions
    ).encode()


async def cut_stream(
    source: AsyncIterator[bytes],
    *,
    ranges: list[tuple[int, int]],
    mode: str,
    delimiter: str,
    complement: bool,
    only_delimited: bool,
    whitespace: str | None,
    no_partial: bool,
    output_delimiter: str | None,
    zero_terminated: bool,
) -> AsyncIterator[bytes]:
    separator = record_separator(zero_terminated)
    reader = AsyncLineIterator(source)
    try:
        while (rec := await reader.readline(separator)) is not None:
            output = _cut_record(
                rec,
                ranges,
                mode,
                delimiter,
                complement,
                only_delimited,
                whitespace,
                no_partial,
                output_delimiter,
            )
            if output is not None:
                yield output + separator
    finally:
        await reader.discard()


__all__ = [
    "cut_stream",
    "parse_ranges",
]
