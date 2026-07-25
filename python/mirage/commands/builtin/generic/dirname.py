from mirage.io.types import ByteSource, IOResult
from mirage.utils.path import gnu_dirname


async def dirname(*texts: str,
                  zero: bool = False) -> tuple[ByteSource | None, IOResult]:
    lines = [gnu_dirname(t) for t in texts]
    separator = "\0" if zero else "\n"
    return (separator.join(lines) + separator).encode(), IOResult()


__all__ = ["dirname"]
