from collections.abc import AsyncIterator
from itertools import cycle

from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    never_opened,
    resolve_source,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn

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
        if (
            char == "\\"
            and index + 1 < len(value)
            and value[index + 1] in _ESCAPES
        ):
            chars.append(_ESCAPES[value[index + 1]])
            index += 2
            continue
        chars.append(char)
        index += 1
    return chars or [""]


def _join_fields(
    fields: tuple[str, ...] | list[str], delimiter_chars: list[str]
) -> str:
    chars = cycle(delimiter_chars)
    result = fields[0] if fields else ""
    for field in fields[1:]:
        result += next(chars) + field
    return result


async def paste_generic(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    delimiters: str = "\t",
    delimiter: str | None = None,
    serial: bool = False,
    zero_terminated: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    read = normalized_read(read_stream)
    shared = AsyncLineIterator(resolve_source(stdin))
    operands = paths or [PathSpec.from_str_path("-")]
    inputs = [
        (p, shared if is_stdin(p) else AsyncLineIterator(read(p)))
        for p in operands
    ]
    chars = _decode_delimiters(
        delimiter if delimiter is not None else delimiters
    )
    separator = record_separator(zero_terminated)
    io = IOResult()
    return _paste_stream(inputs, chars, serial, separator, io), io


async def _paste_stream(
    inputs: list[tuple[PathSpec, AsyncLineIterator]],
    delimiters: list[str],
    serial: bool,
    separator: bytes,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """Paste the operands' records, in rows or one operand per line.

    A failed read is reported, exit 1, and its operand reads as ended, as
    GNU's does; one that never opened stops the rows before any is
    written, and under -s leaves that operand out.

    Args:
        inputs (list[tuple[PathSpec, AsyncLineIterator]]): each operand,
            ``-`` for no operand, with its records; every stdin operand
            shares one reader.
        delimiters (list[str]): the -d list.
        serial (bool): -s.
        separator (bytes): the record terminator.
        io (IOResult): where a failed read is reported.
    """
    errors: list[str] = []

    async def line(
        path: PathSpec, reader: AsyncLineIterator
    ) -> tuple[bytes | None, bool]:
        try:
            return await reader.readline(separator), False
        except FS_ERRORS as exc:
            errors.append(fs_error_line("paste", path, exc))
            io.stderr, io.exit_code = "".join(errors).encode(), 1
            return None, never_opened(reader, path, exc)

    try:
        if serial:
            for path, reader in inputs:
                index = 0
                while True:
                    record, unopened = await line(path, reader)
                    if record is None:
                        break
                    prefix = (
                        ""
                        if index == 0
                        else delimiters[(index - 1) % len(delimiters)]
                    )
                    yield (prefix + record.decode(errors="replace")).encode()
                    index += 1
                if not unopened:
                    yield separator
        else:
            while True:
                row: list[bytes | None] = []
                for path, reader in inputs:
                    record, unopened = await line(path, reader)
                    if unopened:
                        return
                    row.append(record)
                if all(record is None for record in row):
                    return
                yield (
                    _join_fields(
                        [
                            record.decode(errors="replace")
                            if record is not None
                            else ""
                            for record in row
                        ],
                        delimiters,
                    ).encode()
                    + separator
                )
    finally:
        for reader in dict.fromkeys(reader for _, reader in inputs):
            await reader.discard()


__all__ = ["paste_generic"]
