from collections.abc import AsyncIterator, Callable, Sequence
from typing import AnyStr

from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource


def record_separator(zero: bool) -> bytes:
    """The byte that ends a record: NUL under -z, else a newline.

    Args:
        zero (bool): whether the line asked for NUL-terminated records.
    """
    return b"\0" if zero else b"\n"


def split_lines(text: str, sep: str = "\n") -> list[str]:
    lines = text.split(sep)
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def split_lines_keepends(text: str) -> list[str]:
    out: list[str] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == "\n":
            out.append(text[start : i + 1])
            start = i + 1
    if start < len(text):
        out.append(text[start:])
    return out


def join_file_lines(chunks: Sequence[AnyStr], sep: AnyStr) -> AnyStr:
    """Several files' contents as one, each file's last line ended.

    What GNU's record readers see across a file boundary (``sed``,
    ``column``): a file whose last record lacks its separator
    still ends it where the next file begins, so ``ab`` then ``cd`` are
    two lines, never ``abcd``. The last file keeps its own ending, which
    ``sed`` reproduces.

    Args:
        chunks (Sequence[AnyStr]): the files' contents, in order.
        sep (AnyStr): the record separator.
    """
    parts: list[AnyStr] = []
    for index, chunk in enumerate(chunks):
        parts.append(chunk)
        if index < len(chunks) - 1 and chunk and not chunk.endswith(sep):
            parts.append(sep)
    return sep[:0].join(parts)


async def map_stream(
    source: ByteSource, transform: Callable[[bytes], bytes]
) -> AsyncIterator[bytes]:
    """Transform records while retaining their original newline endings.

    Args:
        source (ByteSource): the input, consumed one record at a time.
        transform (Callable): transforms one unterminated record.
    """
    reader = AsyncLineIterator(source)
    try:
        while True:
            line, ended = await reader.read_until(b"\n")
            if not line and not ended:
                return
            yield transform(line) + (b"\n" if ended else b"")
    finally:
        await reader.discard()


__all__ = [
    "join_file_lines",
    "map_stream",
    "split_lines",
    "split_lines_keepends",
]
