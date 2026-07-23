from collections.abc import Awaitable, Callable

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
    delimiter: str,
    record_separator: str,
    include_total: bool,
) -> str:
    out: list[str] = []
    counts = [0, 0, 0]
    for col, text in merged:
        counts[col - 1] += 1
        if col == 1 and not suppress1:
            out.append(text)
        elif col == 2 and not suppress2:
            prefix = "" if suppress1 else delimiter
            out.append(prefix + text)
        elif col == 3 and not suppress3:
            prefix = ""
            if not suppress1:
                prefix += delimiter
            if not suppress2:
                prefix += delimiter
            out.append(prefix + text)
    if include_total:
        visible = [
            str(count)
            for count, suppressed in zip(counts, (suppress1, suppress2,
                                                  suppress3)) if not suppressed
        ]
        out.append(delimiter.join(visible + ["total"]))
    return record_separator.join(out) + record_separator if out else ""


async def comm(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    suppress1: bool = False,
    suppress2: bool = False,
    suppress3: bool = False,
    check_order: bool = False,
    output_delimiter: str = "\t",
    total: bool = False,
    zero_terminated: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.COMM, paths[2].raw_path
                                  or paths[2].virtual)
    if len(paths) < 2:
        raise ValueError("comm: requires two paths")
    data1 = (await read_bytes(paths[0])).decode(errors="replace")
    data2 = (await read_bytes(paths[1])).decode(errors="replace")
    lines1 = data1.rstrip("\0").split(
        "\0") if zero_terminated else split_lines(data1)
    lines2 = data2.rstrip("\0").split(
        "\0") if zero_terminated else split_lines(data2)
    stderr = ""
    if check_order:
        if lines1 != sorted(lines1):
            stderr = "comm: file 1 is not in sorted order\n"
        elif lines2 != sorted(lines2):
            stderr = "comm: file 2 is not in sorted order\n"
    merged = _comm_merge(lines1, lines2)
    output = _format_comm(merged, suppress1, suppress2, suppress3,
                          output_delimiter, "\0" if zero_terminated else "\n",
                          total)
    return output.encode(), IOResult(
        stderr=stderr.encode() if stderr else None,
        exit_code=1 if stderr else 0,
    )


__all__ = ["comm"]
