import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class StringsFlags:
    min_len: int = 4


def parse_flags(flags: Mapping[str, FlagValue]) -> StringsFlags:
    fl = FlagView(flags, spec=SPECS["strings"])
    n_raw = fl.as_str("n")
    return StringsFlags(min_len=int(n_raw) if n_raw else 4)


async def strings(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    min_len: int = 4,
) -> tuple[ByteSource | None, IOResult]:
    pattern = rb"[\x20-\x7e]{" + str(min_len).encode() + rb",}"
    # Each operand is scanned independently and the matches concatenate in
    # operand order, like GNU strings.
    if paths:
        parts: list[bytes] = []
        for p in paths:
            matches = re.findall(pattern, await read_bytes(p))
            if matches:
                parts.append(b"\n".join(matches) + b"\n")
        return b"".join(parts), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = b""
    matches = re.findall(pattern, raw)
    output = b"\n".join(matches) + b"\n" if matches else b""
    return output, IOResult()


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
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "strings")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await strings(readable,
                      read_bytes=materialized_read(stream),
                      stdin=opts.stdin,
                      min_len=parsed.min_len), err)


__all__ = ["strings", "strings_generic"]
