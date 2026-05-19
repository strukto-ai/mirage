import gzip as gziplib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def zcat(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("zcat: missing input")
    return gziplib.decompress(raw), IOResult()


__all__ = ["zcat"]
