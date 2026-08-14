import gzip as gziplib
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def zcat(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    # Each operand decompresses independently and the outputs concatenate
    # in operand order, like GNU zcat.
    if paths:
        parts: list[bytes] = []
        for p in paths:
            parts.append(gziplib.decompress(await read_bytes(p)))
        return b"".join(parts), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("zcat: (stdin): unexpected end of file")
    return gziplib.decompress(raw), IOResult()


async def zcat_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run zcat over resolved operands; mirrors zcatGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by zcat.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    readable, err = await split_readable(paths, stat, "zcat")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await zcat(readable,
                   read_bytes=materialized_read(stream),
                   stdin=opts.stdin), err)


__all__ = ["zcat", "zcat_generic"]
