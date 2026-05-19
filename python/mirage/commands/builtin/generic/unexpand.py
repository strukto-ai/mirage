from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _unexpand_line(line: str, tabsize: int, all_spaces: bool) -> str:
    if all_spaces:
        result: list[str] = []
        i = 0
        while i < len(line):
            count = 0
            while i + count < len(line) and line[i + count] == " ":
                count += 1
            if count >= tabsize:
                tabs = count // tabsize
                remainder = count % tabsize
                result.append("\t" * tabs + " " * remainder)
                i += count
            elif count > 0:
                result.append(" " * count)
                i += count
            else:
                result.append(line[i])
                i += 1
        return "".join(result)
    leading = 0
    while leading < len(line) and line[leading] == " ":
        leading += 1
    if leading >= tabsize:
        tabs = leading // tabsize
        remainder = leading % tabsize
        return "\t" * tabs + " " * remainder + line[leading:]
    return line


async def unexpand(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    tabsize: int = 8,
    all_spaces: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(accessor, p)).decode(errors="replace")
            lines = data.splitlines(True)
            all_text.extend(
                _unexpand_line(ln, tabsize, all_spaces) for ln in lines)
        return "".join(all_text).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("unexpand: missing operand")
    lines = raw.decode(errors="replace").splitlines(True)
    result = [_unexpand_line(ln, tabsize, all_spaces) for ln in lines]
    return "".join(result).encode(), IOResult()


__all__ = ["unexpand"]
