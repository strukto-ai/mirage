from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _parse_range_spec(spec: str) -> list[int]:
    indices: list[int] = []
    for part in spec.split(","):
        if "-" in part:
            lo, hi = part.split("-", 1)
            indices.extend(range(int(lo), int(hi) + 1))
        else:
            indices.append(int(part))
    return indices


def _parse_char_ranges(spec: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for part in spec.split(","):
        if "-" in part:
            lo, hi = part.split("-", 1)
            ranges.append((int(lo), int(hi)))
        else:
            val = int(part)
            ranges.append((val, val))
    return ranges


async def _cut_stream(
    source: AsyncIterator[bytes],
    delimiter: str,
    fields: list[int] | None,
    chars: list[tuple[int, int]] | None,
    complement: bool,
    zero_terminated: bool,
) -> AsyncIterator[bytes]:
    sep = b"\x00" if zero_terminated else b"\n"
    raw = b""
    async for chunk in source:
        raw += chunk
    records = raw.split(sep)
    if records and records[-1] == b"":
        records = records[:-1]
    for rec in records:
        line = rec.decode(errors="replace")
        if chars is not None:
            if complement:
                selected_indices: set[int] = set()
                for s, e in chars:
                    selected_indices.update(range(s - 1, e))
                parts = [
                    line[i] for i in range(len(line))
                    if i not in selected_indices
                ]
                yield "".join(parts).encode() + sep
            else:
                parts = []
                for s, e in chars:
                    parts.append(line[s - 1:e])
                yield "".join(parts).encode() + sep
        elif fields:
            parts_f = line.split(delimiter)
            if complement:
                field_set = set(fields)
                selected = [
                    parts_f[i] for i in range(len(parts_f))
                    if (i + 1) not in field_set
                ]
            else:
                selected = [
                    parts_f[f_idx - 1] for f_idx in fields
                    if 0 < f_idx <= len(parts_f)
                ]
            yield delimiter.join(selected).encode() + sep
        else:
            yield rec + sep


async def cut(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    complement: bool = False,
    z: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    fields = _parse_range_spec(f) if f is not None else None
    chars = _parse_char_ranges(c) if c is not None else None
    delim = d if d is not None else "\t"
    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
    else:
        source = _resolve_source(stdin, "cut: missing operand")
    return _cut_stream(source, delim, fields, chars, complement, z), IOResult()


__all__ = ["cut"]
