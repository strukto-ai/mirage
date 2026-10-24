from functools import partial

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def rev_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run rev over resolved operands; mirrors revGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by rev.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    # util-linux rev opens `-` as a file; only /dev/stdin is stdin.
    stat = stdin_stat(stat, dash=False)
    readable, err = await split_readable(paths, stat, "rev")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin, dash=False)
    each = partial(run_stream, "rev", {})
    output = per_operand(readable, read, ctx.stdin, io, "rev", each)
    return await merge_split_errors((output, io), err)


__all__ = ["rev_generic"]
