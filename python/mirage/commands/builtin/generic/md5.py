import hashlib
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def md5(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        data = await _read_stdin_async(stdin)
        if data is None:
            raise ValueError("md5: missing operand")
        digest = hashlib.md5(data).hexdigest()
        return f"{digest}  -\n".encode(), IOResult()
    outputs: list[str] = []
    for p in paths:
        data = await read_bytes(p)
        digest = hashlib.md5(data).hexdigest()
        outputs.append(f"{digest}  {p.raw_path}")
    return format_records(outputs), IOResult()


__all__ = ["md5"]
