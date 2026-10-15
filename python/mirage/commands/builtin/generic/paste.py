from collections.abc import AsyncIterator
from itertools import cycle

from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
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
    readers = [
        shared if is_stdin(p) else AsyncLineIterator(read(p)) for p in paths
    ] or [shared]
    chars = _decode_delimiters(
        delimiter if delimiter is not None else delimiters
    )
    separator = b"\0" if zero_terminated else b"\n"
    return _paste_stream(readers, chars, serial, separator), IOResult()


async def _paste_stream(
    readers: list[AsyncLineIterator],
    delimiters: list[str],
    serial: bool,
    separator: bytes,
) -> AsyncIterator[bytes]:
    try:
        if serial:
            for reader in readers:
                index = 0
                while (record := await reader.readline(separator)) is not None:
                    prefix = (
                        ""
                        if index == 0
                        else delimiters[(index - 1) % len(delimiters)]
                    )
                    yield (prefix + record.decode(errors="replace")).encode()
                    index += 1
                yield separator
        else:
            while True:
                row = [await reader.readline(separator) for reader in readers]
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
        for reader in dict.fromkeys(readers):
            await reader.discard()


__all__ = ["paste_generic"]
