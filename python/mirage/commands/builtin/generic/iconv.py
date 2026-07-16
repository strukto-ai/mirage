from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def iconv(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
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
        stdin_raw = await _read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    decoded = raw.decode(from_enc, errors=err_mode)
    encoded = decoded.encode(to_enc, errors=err_mode)
    if output_path is not None:
        await write_bytes(accessor, output_path, encoded)
        return None, IOResult(writes={output_path.mount_path: encoded})
    return encoded, IOResult()


__all__ = ["iconv"]
