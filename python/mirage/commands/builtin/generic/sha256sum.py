import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.generic.checksum import hashsum
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sha256sum(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    check: bool = False,
    binary: bool = False,
    tag: bool = False,
    zero: bool = False,
    strict: bool = False,
    ignore_missing: bool = False,
    status: bool = False,
    quiet: bool = False,
    warn: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    return await hashsum(paths,
                         factory=hashlib.sha256,
                         algorithm="sha256",
                         read_bytes=read_bytes,
                         read_stream=read_stream,
                         stdin=stdin,
                         check=check,
                         binary=binary,
                         tag=tag,
                         zero=zero,
                         strict=strict,
                         ignore_missing=ignore_missing,
                         status=status,
                         quiet=quiet,
                         warn=warn)


__all__ = ["sha256sum"]
