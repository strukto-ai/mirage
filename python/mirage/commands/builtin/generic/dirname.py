from mirage.io.types import ByteSource, IOResult
from mirage.utils.path import gnu_dirname


async def dirname(*texts: str) -> tuple[ByteSource | None, IOResult]:
    lines = [gnu_dirname(t) for t in texts]
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["dirname"]
