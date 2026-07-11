import re
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def strings(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    min_len: int = 4,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raw = b""
    pattern = rb"[\x20-\x7e]{" + str(min_len).encode() + rb",}"
    matches = re.findall(pattern, raw)
    output = b"\n".join(matches) + b"\n" if matches else b""
    return output, IOResult()


__all__ = ["strings"]
