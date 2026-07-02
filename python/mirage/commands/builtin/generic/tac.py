from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
) -> tuple[ByteSource | None, IOResult]:
    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        cache = [paths[0].mount_path]
    else:
        source = _resolve_source(stdin)

    lines: list[bytes] = []
    async for line in AsyncLineIterator(source):
        lines.append(line)
    lines.reverse()
    if not lines:
        return b"", IOResult(cache=cache)
    return b"\n".join(lines) + b"\n", IOResult(cache=cache)


__all__ = ["tac"]
