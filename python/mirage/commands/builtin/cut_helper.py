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

from collections.abc import AsyncIterator

OPEN_END = 2**31 - 1


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
        for p in range(start, end + 1):
            in_set.add(p)
    if complement:
        return [p for p in range(1, n + 1) if p not in in_set]
    return [p for p in range(1, n + 1) if p in in_set]


def split_records(raw: bytes, zero_terminated: bool) -> list[bytes]:
    sep = b"\x00" if zero_terminated else b"\n"
    records = raw.split(sep)
    if records and records[-1] == b"":
        records = records[:-1]
    return records


def cut_record(rec: bytes, delimiter: str,
               field_ranges: list[tuple[int, int]] | None,
               char_ranges: list[tuple[int, int]] | None,
               complement: bool) -> bytes:
    line = rec.decode(errors="replace")
    if char_ranges is not None:
        positions = select_positions(char_ranges, len(line), complement)
        return "".join(line[p - 1] for p in positions).encode()
    if field_ranges is not None:
        parts = line.split(delimiter)
        if len(parts) == 1:
            return rec
        positions = select_positions(field_ranges, len(parts), complement)
        return delimiter.join(parts[p - 1] for p in positions).encode()
    return rec


async def cut_stream(
    source: AsyncIterator[bytes],
    delimiter: str,
    field_ranges: list[tuple[int, int]] | None,
    char_ranges: list[tuple[int, int]] | None,
    complement: bool,
    zero_terminated: bool,
) -> AsyncIterator[bytes]:
    sep = b"\x00" if zero_terminated else b"\n"
    raw = b""
    async for chunk in source:
        raw += chunk
    for rec in split_records(raw, zero_terminated):
        yield cut_record(rec, delimiter, field_ranges, char_ranges,
                         complement) + sep


__all__ = [
    "OPEN_END",
    "cut_record",
    "cut_stream",
    "parse_ranges",
    "select_positions",
    "split_records",
]
