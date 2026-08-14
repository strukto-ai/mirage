import hashlib
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def md5(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        data = await _read_stdin_async(stdin)
        if data is None:
            raise ValueError("md5: missing operand")
        digest = hashlib.md5(data).hexdigest()
        return f"{digest}  -\n".encode(), IOResult()
    outputs: list[str] = []
    for p in paths:
        data = await read_bytes(p)
        digest = hashlib.md5(data).hexdigest()
        outputs.append(f"{digest}  {p.raw_path}")
    return format_records(outputs), IOResult()


async def md5_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run BSD md5 over resolved operands; mirrors md5Generic.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by md5.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    readable, err = await split_readable(paths, stat, "md5")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await md5(readable,
                  read_bytes=materialized_read(stream),
                  stdin=opts.stdin), err)


__all__ = ["md5", "md5_generic"]
