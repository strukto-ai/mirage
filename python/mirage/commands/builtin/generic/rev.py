from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def rev(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            all_lines.extend(split_lines(data))
        reversed_lines = [line[::-1] for line in all_lines]
        return (("\n".join(reversed_lines) +
                 "\n").encode() if all_lines else b""), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("rev: missing operand")
    lines = split_lines(raw.decode(errors="replace"))
    reversed_lines = [line[::-1] for line in lines]
    return (("\n".join(reversed_lines) +
             "\n").encode() if lines else b""), IOResult()


__all__ = ["rev"]
