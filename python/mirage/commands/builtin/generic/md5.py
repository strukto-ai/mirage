import hashlib
from collections.abc import Awaitable, Callable

from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def md5(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("md5: missing operand")
    outputs: list[str] = []
    for p in paths:
        data = await read_bytes(accessor, p)
        digest = hashlib.md5(data).hexdigest()
        outputs.append(f"{digest}  {p.original}")
    return "\n".join(outputs).encode(), IOResult()


__all__ = ["md5"]
