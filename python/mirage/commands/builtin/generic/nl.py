import re
from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _should_number(line: str, body_numbering: str,
                   pattern: re.Pattern[str] | None) -> bool:
    if body_numbering == "n":
        return False
    if body_numbering == "a":
        return True
    if body_numbering == "p" and pattern is not None:
        return pattern.search(line) is not None
    return bool(line.strip())


async def _nl_stream(
    source: AsyncIterator[bytes],
    body_numbering: str,
    start: int,
    increment: int,
    width: int,
    separator: str,
    pattern: re.Pattern[str] | None,
) -> AsyncIterator[bytes]:
    num = start
    async for raw_line in AsyncLineIterator(source):
        line = raw_line.decode(errors="replace")
        if _should_number(line, body_numbering, pattern):
            yield f"{num:{width}d}{separator}{line}\n".encode()
            num += increment
        else:
            yield f"{' ' * width}{separator}{line}\n".encode()


async def _nl_multi(
    accessor: object,
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
    body_numbering: str,
    start: int,
    increment: int,
    width: int,
    separator: str,
    pattern: re.Pattern[str] | None,
) -> AsyncIterator[bytes]:
    for p in paths:
        source = read_stream(accessor, p)
        async for chunk in _nl_stream(source, body_numbering, start, increment,
                                      width, separator, pattern):
            yield chunk


async def nl(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    body_numbering_raw: str | None = None,
    start_raw: str | None = None,
    increment_raw: str | None = None,
    width_raw: str | None = None,
    separator: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    raw = body_numbering_raw if body_numbering_raw is not None else "t"
    pattern: re.Pattern[str] | None = None
    if raw.startswith("p"):
        body_numbering = "p"
        pattern = re.compile(raw[1:])
    else:
        body_numbering = raw
    start = int(start_raw) if start_raw is not None else 1
    increment = int(increment_raw) if increment_raw is not None else 1
    width = int(width_raw) if width_raw is not None else 6
    sep = separator if separator is not None else "\t"

    if paths:
        return _nl_multi(accessor, paths, read_stream, body_numbering, start,
                         increment, width, sep, pattern), IOResult()
    source = _resolve_source(stdin, "nl: missing operand")
    return _nl_stream(source, body_numbering, start, increment, width, sep,
                      pattern), IOResult()


__all__ = ["nl"]
