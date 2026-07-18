from collections.abc import Awaitable, Callable
from itertools import zip_longest

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def paste(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    delimiter: str = "\t",
    serial: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    file_lines: list[list[str]] = []
    remaining_stdin = stdin
    for p in paths:
        if p.virtual == "-":
            raw = await _read_stdin_async(remaining_stdin)
            data = raw.decode(errors="replace") if raw else ""
            remaining_stdin = None
        else:
            data = (await read_bytes(p)).decode(errors="replace")
        file_lines.append(split_lines(data))

    if not file_lines and remaining_stdin is not None:
        raw = await _read_stdin_async(remaining_stdin)
        if raw:
            file_lines.append(split_lines(raw.decode(errors="replace")))

    if not file_lines:
        raise ValueError("paste: missing operand")

    if serial:
        out_lines = [delimiter.join(lines) for lines in file_lines]
    else:
        out_lines = [
            delimiter.join(row)
            for row in zip_longest(*file_lines, fillvalue="")
        ]
    return ("\n".join(out_lines) + "\n").encode(), IOResult()


__all__ = ["paste"]
