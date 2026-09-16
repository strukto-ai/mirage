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

from mirage.commands.quote import quote_text
from mirage.commands.spec.usage import usage_hint

_OPEN_END = 2**31 - 1
_BLANKS = re.compile(r"[ \t]+")
_CUT_TRY = usage_hint("cut")
# What closes the position being read: a comma, a space, a TAB, or the
# end of the string (the empty sentinel). NOT a newline, which is an
# invalid character here -- `cut -f $'1\n2'` is refused and quotes
# `'\n2'`, where `-f '1\t2'` selects fields 1 and 2. Probed over all 255
# bytes: the only separators are 0x09, 0x20 and 0x2c, and every other
# non-digit non-dash byte is an invalid field value. Ground truth NL3-G.
_TERMINATORS = ("", ",", " ", "\t")


@dataclass(frozen=True, slots=True)
class _ListWords:
    value: str
    span: str
    zero: str


# GNU words the two modes differently and never shares a string between
# them; only "invalid decreasing range" carries no mode noun.
_FIELD_WORDS = _ListWords("invalid field value", "invalid field range",
                          "fields are numbered from 1")
# The two range strings are worded differently from each other on
# purpose: the position one joins the nouns with a slash, the range one
# spells out " or ". Both are byte-exact against coreutils 9.4.
_POSITION_WORDS = _ListWords("invalid byte/character position",
                             "invalid byte or character range",
                             "byte/character positions are numbered from 1")


def _cut_error(message: str) -> ValueError:
    return ValueError(f"cut: {message}\n{_CUT_TRY}")


def parse_ranges(spec: str, mode: str) -> list[tuple[int, int]]:
    """GNU's byte/character/field list, read the way GNU reads it.

    One character at a time, where a comma, a blank, a newline or the end
    of the string closes the position being read. The scan is what
    reproduces GNU's quoting: it refuses at the first character it cannot
    read and quotes the rest of the string from there, so ``-f 2-3x`` and
    ``-f 1,2x`` both report ``'x'`` while ``-f abc`` reports ``'abc'``. It
    is also why ``-f '2 '`` reports "numbered from 1" rather than naming
    the blank: the blank closes field 2, and the end of the string then
    closes a second, empty position. ``-b`` and ``-c`` share the scan and
    differ only in wording, which GNU keeps distinct from ``-f``'s.

    Args:
        spec (str): the raw ``-b``/``-c``/``-f`` list.
        mode (str): "bytes", "characters" or "fields", which picks the
            wording of every refusal.

    Returns:
        list[tuple[int, int]]: the inclusive 1-based ranges, in the order
            they were written; an open end is ``_OPEN_END``.

    Raises:
        ValueError: the two stderr lines to print, exit 1. Never a
            partially parsed list.
    """
    words = _FIELD_WORDS if mode == "fields" else _POSITION_WORDS
    ranges: list[tuple[int, int]] = []
    value = 0
    digits = False
    lo = 0
    dash_found = False
    for index in range(len(spec) + 1):
        char = spec[index] if index < len(spec) else ""
        if "0" <= char <= "9":
            value = value * 10 + (ord(char) - 48)
            digits = True
            continue
        if char == "-":
            if dash_found:
                raise _cut_error(words.span)
            # `-2` opens the range at 1; `0-2` gave a zero it did read.
            if digits and value == 0:
                raise _cut_error(words.zero)
            dash_found = True
            lo = value if digits else 1
            value = 0
            digits = False
            continue
        if char in _TERMINATORS:
            if dash_found:
                hi = value if digits else _OPEN_END
                if hi < lo:
                    raise _cut_error("invalid decreasing range")
                ranges.append((lo, hi))
                dash_found = False
            else:
                if value == 0:
                    raise _cut_error(words.zero)
                ranges.append((value, value))
            value = 0
            digits = False
            if char == "":
                return ranges
            continue
        raise _cut_error(f"{words.value} '{quote_text(spec[index:])}'")
    return ranges


def _select_positions(ranges: list[tuple[int, int]], n: int,
                      complement: bool) -> list[int]:
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


def _split_records(raw: bytes, zero_terminated: bool) -> list[bytes]:
    separator = b"\x00" if zero_terminated else b"\n"
    records = raw.split(separator)
    if records and records[-1] == b"":
        records = records[:-1]
    return records


def _join_position_groups(parts: list[bytes], positions: list[int],
                          output_delimiter: bytes | None) -> bytes:
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


def _cut_bytes(rec: bytes, ranges: list[tuple[int, int]], complement: bool,
               no_partial: bool, output_delimiter: bytes | None) -> bytes:
    positions = _select_positions(ranges, len(rec), complement)
    if not no_partial:
        return _join_position_groups([bytes((byte, )) for byte in rec],
                                     positions, output_delimiter)
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
        if index == 0 or part_positions[index] != (part_positions[index - 1] +
                                                   len(parts[index - 1])):
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
    output_bytes = (output_delimiter.encode()
                    if output_delimiter is not None else None)
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
    separator = (output_delimiter
                 if output_delimiter is not None else default_output)
    return separator.join(fields[position - 1]
                          for position in positions).encode()


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
    separator = b"\x00" if zero_terminated else b"\n"
    raw = b""
    async for chunk in source:
        raw += chunk
    for rec in _split_records(raw, zero_terminated):
        output = _cut_record(rec, ranges, mode, delimiter, complement,
                             only_delimited, whitespace, no_partial,
                             output_delimiter)
        if output is not None:
            yield output + separator


__all__ = [
    "cut_stream",
    "parse_ranges",
]
