from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _comm_merge(lines1: list[str], lines2: list[str]) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    i, j = 0, 0
    while i < len(lines1) and j < len(lines2):
        if lines1[i] < lines2[j]:
            result.append((1, lines1[i]))
            i += 1
        elif lines1[i] > lines2[j]:
            result.append((2, lines2[j]))
            j += 1
        else:
            result.append((3, lines1[i]))
            i += 1
            j += 1
    while i < len(lines1):
        result.append((1, lines1[i]))
        i += 1
    while j < len(lines2):
        result.append((2, lines2[j]))
        j += 1
    return result


def _format_comm(
    merged: list[tuple[int, str]],
    suppress1: bool,
    suppress2: bool,
    suppress3: bool,
) -> str:
    out: list[str] = []
    for col, text in merged:
        if col == 1 and not suppress1:
            out.append(text)
        elif col == 2 and not suppress2:
            prefix = "" if suppress1 else "\t"
            out.append(prefix + text)
        elif col == 3 and not suppress3:
            prefix = ""
            if not suppress1:
                prefix += "\t"
            if not suppress2:
                prefix += "\t"
            out.append(prefix + text)
    return "\n".join(out) + "\n" if out else ""


async def comm(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    suppress1: bool = False,
    suppress2: bool = False,
    suppress3: bool = False,
    check_order: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.COMM, paths[2].raw_path)
    if len(paths) < 2:
        raise ValueError("comm: requires two paths")
    data1 = (await read_bytes(accessor, paths[0])).decode(errors="replace")
    data2 = (await read_bytes(accessor, paths[1])).decode(errors="replace")
    lines1 = split_lines(data1)
    lines2 = split_lines(data2)
    stderr = ""
    if check_order:
        if lines1 != sorted(lines1):
            stderr = "comm: file 1 is not in sorted order\n"
        elif lines2 != sorted(lines2):
            stderr = "comm: file 2 is not in sorted order\n"
    merged = _comm_merge(lines1, lines2)
    output = _format_comm(merged, suppress1, suppress2, suppress3)
    return output.encode(), IOResult(
        stderr=stderr.encode() if stderr else None)


__all__ = ["comm"]
