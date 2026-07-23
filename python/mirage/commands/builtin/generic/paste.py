from collections.abc import Awaitable, Callable
from itertools import cycle, zip_longest

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

_ESCAPES = {"n": "\n", "t": "\t", "\\": "\\", "0": ""}


def _decode_delimiters(value: str) -> list[str]:
    """Expand the ``-d`` delimiter list into one delimiter per element.

    GNU ``paste`` recognizes exactly ``\\n``, ``\\t``, ``\\\\`` and ``\\0``,
    where ``\\0`` means the empty delimiter (fields are concatenated) rather
    than a NUL byte. A single left-to-right scan keeps ``\\\\0`` reading as a
    backslash followed by ``0``.

    Args:
        value (str): Raw ``-d``/``--delimiters`` argument.
    """
    chars: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "\\" and index + 1 < len(value) and value[index +
                                                             1] in _ESCAPES:
            chars.append(_ESCAPES[value[index + 1]])
            index += 2
            continue
        chars.append(char)
        index += 1
    return chars or [""]


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
    delimiter_chars = _decode_delimiters(delimiter_sequence)

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
