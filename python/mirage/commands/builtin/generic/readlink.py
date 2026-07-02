import posixpath

from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def readlink(
    paths: list[PathSpec],
    *,
    f: bool = False,
    e: bool = False,
    m: bool = False,
    n: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("readlink: missing operand")
    normalize = f or e or m
    results: list[str] = []
    for p in paths:
        vp = p.virtual
        if normalize:
            vp = posixpath.normpath(vp)
        results.append(vp)
    text = "\n".join(results)
    if not n:
        text += "\n"
    return text.encode(), IOResult()


__all__ = ["readlink"]
