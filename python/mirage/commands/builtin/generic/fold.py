from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _fold_line(line: str, width: int, break_spaces: bool) -> str:
    if len(line) <= width:
        return line
    parts: list[str] = []
    while len(line) > width:
        if break_spaces:
            idx = line.rfind(" ", 0, width)
            if idx > 0:
                parts.append(line[:idx + 1])
                line = line[idx + 1:]
            else:
                parts.append(line[:width])
                line = line[width:]
        else:
            parts.append(line[:width])
            line = line[width:]
    if line:
        parts.append(line)
    return "\n".join(parts)


async def fold(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    width: int = 80,
    break_spaces: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(accessor, p)).decode(errors="replace")
            for line in split_lines(data):
                all_lines.append(_fold_line(line, width, break_spaces))
        return ("\n".join(all_lines) + "\n").encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("fold: missing operand")
    lines = split_lines(raw.decode(errors="replace"))
    result = [_fold_line(ln, width, break_spaces) for ln in lines]
    return ("\n".join(result) + "\n").encode(), IOResult()


__all__ = ["fold"]
