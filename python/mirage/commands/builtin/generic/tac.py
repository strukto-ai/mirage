import re
from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _reverse_source(source: AsyncIterator[bytes], separator: str,
                          before: bool, regex: bool) -> bytes:
    data = b"".join([chunk async for chunk in source])
    text = data.decode(errors="replace")
    pattern = separator if regex else re.escape(separator)
    parts = re.split(f"({pattern})", text)
    records: list[str] = []
    for index in range(0, len(parts) - 1, 2):
        records.append(parts[index + 1] +
                       parts[index] if before else parts[index] +
                       parts[index + 1])
    if len(parts) % 2 == 1 and parts[-1]:
        records.append(parts[-1])
    records.reverse()
    return "".join(records).encode()


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    separator: str = "\n",
    before: bool = False,
    regex: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        cache = [p.mount_path for p in paths]
        parts: list[bytes] = []
        for p in paths:
            parts.append(await _reverse_source(read_stream(p), separator,
                                               before, regex))
        return b"".join(parts), IOResult(cache=cache)

    source = _resolve_source(stdin)
    return await _reverse_source(source, separator, before, regex), IOResult()


__all__ = ["tac"]
