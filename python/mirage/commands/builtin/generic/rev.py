from functools import partial

from mirage.commands.builtin.utils.lines import map_stream
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def rev(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    read = stdin_stream(read_stream, stdin, dash=False)
    each = partial(map_stream, transform=_reversed)
    return per_operand(paths, read, stdin, io, "rev", each), io


def _reversed(line: bytes) -> bytes:
    return line.decode(errors="replace")[::-1].encode()


async def rev_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run rev over resolved operands; mirrors revGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by rev.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    # util-linux rev opens `-` as a file; only /dev/stdin is stdin.
    stat = stdin_stat(stat, dash=False)
    readable, err = await split_readable(paths, stat, "rev")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await rev(readable, read_stream=stream, stdin=opts.stdin),
        err,
    )


__all__ = ["rev", "rev_generic"]
