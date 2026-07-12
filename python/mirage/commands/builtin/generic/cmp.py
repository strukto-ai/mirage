from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def cmp_cmd(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    silent: bool = False,
    verbose: bool = False,
    limit: int | None = None,
    print_bytes: bool = False,
    skip: int | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.CMP, paths[2].raw_path)
    if len(paths) < 2:
        raise UsageError("cmp: requires two paths")
    p0, p1 = paths[0], paths[1]
    data1 = await read_bytes(accessor, p0)
    data2 = await read_bytes(accessor, p1)
    if skip is not None:
        data1 = data1[skip:]
        data2 = data2[skip:]
    if limit is not None:
        data1 = data1[:limit]
        data2 = data2[:limit]
    if data1 == data2:
        return None, IOResult()
    if silent:
        return None, IOResult(exit_code=1)
    if verbose:
        out_lines: list[str] = []
        for idx in range(min(len(data1), len(data2))):
            if data1[idx] != data2[idx]:
                out_lines.append(f"{idx + 1} {data1[idx]:o} {data2[idx]:o}")
        return format_records(out_lines), IOResult(exit_code=1)
    for idx in range(min(len(data1), len(data2))):
        if data1[idx] != data2[idx]:
            line = 1 + data1[:idx].count(ord(b"\n"))
            msg = (f"{p0.virtual} {p1.virtual}"
                   f" differ: char {idx + 1}, line {line}")
            if print_bytes:
                msg += (f" is {data1[idx]:o} {chr(data1[idx])}"
                        f" {data2[idx]:o} {chr(data2[idx])}")
            return format_records([msg]), IOResult(exit_code=1)
    shorter = p0.virtual if len(data1) < len(data2) else p1.virtual
    msg = f"cmp: EOF on {shorter}"
    return format_records([msg]), IOResult(exit_code=1)


__all__ = ["cmp_cmd"]
