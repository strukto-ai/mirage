from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tee(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    append: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = (" ".join(texts)).encode() if texts else b""
    write_data = raw
    if append:
        try:
            existing = b""
            async for chunk in read_stream(accessor, paths[0]):
                existing += chunk
            write_data = existing + raw
        except FileNotFoundError:
            # GNU tee -a creates a missing file: append to empty.
            pass
    await write_bytes(accessor, paths[0], write_data)
    return raw, IOResult(writes={paths[0].mount_path: write_data},
                         cache=[paths[0].mount_path])


__all__ = ["tee"]
