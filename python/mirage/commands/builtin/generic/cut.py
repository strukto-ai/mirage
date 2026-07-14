from collections.abc import AsyncIterator, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.cut_helper import cut_stream, parse_ranges
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def cut(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    complement: bool = False,
    z: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    field_ranges = parse_ranges(f) if f is not None else None
    char_ranges = parse_ranges(c) if c is not None else None
    delim = d if d is not None else "\t"
    if paths:
        # Each operand is cut independently and the outputs concatenate in
        # operand order, like GNU (a file without a trailing newline never
        # merges its last line into the next operand's first).
        outputs = [
            cut_stream(read_stream(accessor, p), delim, field_ranges,
                       char_ranges, complement, z) for p in paths
        ]
        return async_chain(*outputs), IOResult()
    source = _resolve_source(stdin, "cut: missing operand")
    return cut_stream(source, delim, field_ranges, char_ranges, complement,
                      z), IOResult()


__all__ = ["cut"]
