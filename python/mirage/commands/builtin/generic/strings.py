from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class StringsFlags:
    min_len: int = 4


def parse_flags(flags: Mapping[str, FlagValue]) -> StringsFlags:
    fl = FlagView(flags, spec=SPECS["strings"])
    n_raw = fl.as_str("n")
    return StringsFlags(min_len=int(n_raw) if n_raw else 4)


async def _strings_stream(
    source: ByteSource, min_len: int
) -> AsyncIterator[bytes]:
    prefix = bytearray()
    printing = False
    async with aclosing(chunks(source)) as source_chunks:
        async for data in source_chunks:
            output = bytearray()
            for byte in data:
                if 32 <= byte <= 126:
                    if printing:
                        output.append(byte)
                    else:
                        prefix.append(byte)
                        if len(prefix) >= min_len:
                            output.extend(prefix)
                            prefix.clear()
                            printing = True
                else:
                    if printing:
                        output.append(10)
                    prefix.clear()
                    printing = False
            if output:
                yield bytes(output)
    if printing:
        yield b"\n"


async def strings(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    min_len: int = 4,
) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    read = stdin_stream(read_stream, stdin, dash=False)
    each = partial(_strings_stream, min_len=min_len)
    return per_operand(paths, read, stdin, io, "strings", each), io


async def strings_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run strings over resolved operands; mirrors stringsGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by strings.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    # binutils strings never reads `-` as stdin; only /dev/stdin is.
    stat = stdin_stat(stat, dash=False)
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "strings")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await strings(
            readable,
            read_stream=stream,
            stdin=opts.stdin,
            min_len=parsed.min_len,
        ),
        err,
    )


__all__ = ["strings", "strings_generic"]
