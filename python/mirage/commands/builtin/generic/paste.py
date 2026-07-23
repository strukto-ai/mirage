from collections.abc import Awaitable, Callable
from itertools import cycle, zip_longest

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _join_fields(fields: tuple[str, ...] | list[str],
                 delimiter_chars: list[str]) -> str:
    chars = cycle(delimiter_chars)
    result = fields[0] if fields else ""
    for field in fields[1:]:
        result += next(chars) + field
    return result


async def paste(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    delimiters: str = "\t",
    delimiter: str | None = None,
    serial: bool = False,
    zero_terminated: bool = False,
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
        file_lines.append(
            data.rstrip("\0").
            split("\0") if zero_terminated else split_lines(data))

    if not file_lines:
        raw = await _read_stdin_async(remaining_stdin)
        data = raw.decode(errors="replace") if raw is not None else ""
        file_lines.append(
            data.rstrip("\0").
            split("\0") if zero_terminated else split_lines(data))

    delimiter_sequence = delimiter if delimiter is not None else delimiters
    decoded = bytes(delimiter_sequence, "utf-8").decode("unicode_escape")
    delimiter_chars = list(decoded) or [""]

    if serial:
        out_lines = [
            _join_fields(lines, delimiter_chars) for lines in file_lines
            if lines
        ]
    else:
        out_lines = [
            _join_fields(row, delimiter_chars)
            for row in zip_longest(*file_lines, fillvalue="")
        ]
    separator = "\0" if zero_terminated else "\n"
    output = (separator.join(out_lines) +
              separator).encode() if out_lines else b""
    return output, IOResult()


__all__ = ["paste"]
