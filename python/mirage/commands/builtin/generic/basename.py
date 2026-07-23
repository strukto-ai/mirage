from mirage.io.types import ByteSource, IOResult
from mirage.utils.path import gnu_basename


async def basename(
    *texts: str,
    multiple: bool = False,
    suffix: str | None = None,
    zero: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if suffix is not None:
        lines = [gnu_basename(text, suffix) for text in texts]
    elif len(texts) == 2 and not multiple:
        lines = [gnu_basename(texts[0], texts[1])]
    else:
        lines = [gnu_basename(t) for t in texts]
    separator = "\0" if zero else "\n"
    return (separator.join(lines) + separator).encode(), IOResult()


__all__ = ["basename"]
