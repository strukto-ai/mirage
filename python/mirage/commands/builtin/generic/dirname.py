import posixpath

from mirage.io.types import ByteSource, IOResult


async def dirname(*texts: str) -> tuple[ByteSource | None, IOResult]:
    lines = [posixpath.dirname(t) for t in texts]
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["dirname"]
