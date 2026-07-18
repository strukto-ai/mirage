from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    # Each operand is reversed independently and the outputs concatenate in
    # operand order, like GNU tac.
    if paths:
        cache = [p.mount_path for p in paths]
        parts: list[bytes] = []
        for p in paths:
            lines = [line async for line in AsyncLineIterator(read_stream(p))]
            lines.reverse()
            if lines:
                parts.append(b"\n".join(lines) + b"\n")
        return b"".join(parts), IOResult(cache=cache)

    source = _resolve_source(stdin)
    lines = [line async for line in AsyncLineIterator(source)]
    lines.reverse()
    if not lines:
        return b"", IOResult()
    return b"\n".join(lines) + b"\n", IOResult()


__all__ = ["tac"]
