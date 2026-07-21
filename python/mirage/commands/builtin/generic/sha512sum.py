import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.generic.checksum import hashsum
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sha512sum(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    check: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    return await hashsum(paths,
                         factory=hashlib.sha512,
                         read_bytes=read_bytes,
                         read_stream=read_stream,
                         stdin=stdin,
                         check=check)


__all__ = ["sha512sum"]
