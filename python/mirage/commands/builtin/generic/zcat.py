import gzip as gziplib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def zcat(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
) -> tuple[ByteSource | None, IOResult]:
    # Each operand decompresses independently and the outputs concatenate
    # in operand order, like GNU zcat.
    if paths:
        parts: list[bytes] = []
        for p in paths:
            parts.append(gziplib.decompress(await read_bytes(accessor, p)))
        return b"".join(parts), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("zcat: (stdin): unexpected end of file")
    return gziplib.decompress(raw), IOResult()


__all__ = ["zcat"]
