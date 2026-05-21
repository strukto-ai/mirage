from mirage.commands.builtin.path_helper import gnu_basename
from mirage.io.types import ByteSource, IOResult


async def basename(*texts: str) -> tuple[ByteSource | None, IOResult]:
    if len(texts) == 2:
        lines = [gnu_basename(texts[0], texts[1])]
    else:
        lines = [gnu_basename(t) for t in texts]
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["basename"]
