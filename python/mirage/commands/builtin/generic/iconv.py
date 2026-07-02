from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def iconv(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    from_enc: str = "utf-8",
    to_enc: str = "utf-8",
    ignore_errors: bool = False,
    output_path: PathSpec | None = None,
) -> tuple[ByteSource | None, IOResult]:
    err_mode = "ignore" if ignore_errors else "strict"
    if paths:
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raw = b""
    decoded = raw.decode(from_enc, errors=err_mode)
    encoded = decoded.encode(to_enc, errors=err_mode)
    if output_path is not None:
        target = output_path.mount_path
        await write_bytes(accessor, target, encoded)
        return None, IOResult(writes={target: encoded})
    return encoded, IOResult()


__all__ = ["iconv"]
