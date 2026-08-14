from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


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
    readable, err = await split_readable(paths, stat, "rev")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await rev(readable,
                  read_bytes=materialized_read(stream),
                  stdin=opts.stdin), err)


__all__ = ["rev", "rev_generic"]
