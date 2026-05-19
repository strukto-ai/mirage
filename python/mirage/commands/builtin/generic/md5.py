import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def md5(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        data = await _read_stdin_async(stdin)
        if data is None:
            raise ValueError("md5: missing operand")
        digest = hashlib.md5(data).hexdigest()
        return f"{digest}  -\n".encode(), IOResult()
    outputs: list[str] = []
    for p in paths:
        data = await read_bytes(accessor, p)
        digest = hashlib.md5(data).hexdigest()
        outputs.append(f"{digest}  {p.original}")
    return "\n".join(outputs).encode(), IOResult()


__all__ = ["md5"]
