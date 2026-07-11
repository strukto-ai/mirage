from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _table_format(text: str, separator: str | None, output_sep: str) -> str:
    lines = split_lines(text)
    if not lines:
        return ""
    rows: list[list[str]] = []
    for line in lines:
        if separator:
            rows.append(line.split(separator))
        else:
            rows.append(line.split())
    if not rows:
        return ""
    max_cols = max(len(r) for r in rows)
    widths = [0] * max_cols
    for row in rows:
        for idx, cell in enumerate(row):
            if len(cell) > widths[idx]:
                widths[idx] = len(cell)
    out: list[str] = []
    for row in rows:
        parts: list[str] = []
        for idx, cell in enumerate(row):
            if idx < len(row) - 1:
                parts.append(cell.ljust(widths[idx]))
            else:
                parts.append(cell)
        out.append(output_sep.join(parts))
    return "\n".join(out) + "\n"


async def column(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    table: bool = False,
    separator: str | None = None,
    output_separator: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raw = b""
    text = raw.decode(errors="replace")
    if table:
        out = _table_format(
            text, separator,
            output_separator if output_separator is not None else "  ")
    else:
        out = text
    return out.encode(), IOResult()


__all__ = ["column"]
