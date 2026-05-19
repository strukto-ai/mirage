import posixpath

from mirage.io.types import ByteSource, IOResult


async def basename(*texts: str) -> tuple[ByteSource | None, IOResult]:
    lines = [posixpath.basename(t) for t in texts]
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["basename"]
