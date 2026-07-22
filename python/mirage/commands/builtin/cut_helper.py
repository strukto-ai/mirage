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

OPEN_END = 2**31 - 1
_BLANKS = re.compile(r"[ \t]+")


def parse_ranges(spec: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for part in spec.split(","):
        if "-" in part:
            lo, hi = part.split("-", 1)
            lo_v = 1 if lo == "" else int(lo)
            hi_v = OPEN_END if hi == "" else int(hi)
            ranges.append((lo_v, hi_v))
        else:
            val = int(part)
            ranges.append((val, val))
    return ranges


def select_positions(ranges: list[tuple[int, int]], n: int,
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


def split_records(raw: bytes, zero_terminated: bool) -> list[bytes]:
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
    positions = select_positions(ranges, len(rec), complement)
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


def cut_record(
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
        positions = select_positions(ranges, len(text), complement)
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
    positions = select_positions(ranges, len(fields), complement)
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
    for rec in split_records(raw, zero_terminated):
        output = cut_record(rec, ranges, mode, delimiter, complement,
                            only_delimited, whitespace, no_partial,
                            output_delimiter)
        if output is not None:
            yield output + separator


__all__ = [
    "OPEN_END",
    "cut_record",
    "cut_stream",
    "parse_ranges",
    "select_positions",
    "split_records",
]
