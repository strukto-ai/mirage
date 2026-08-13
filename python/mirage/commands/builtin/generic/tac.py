import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (merge_split_errors,
                                                    normalized_read,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class TacFlags:
    separator: str = "\n"
    before: bool = False
    regex: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> TacFlags:
    fl = FlagView(flags, spec=SPECS["tac"])
    return TacFlags(
        separator=fl.as_str("separator") or "\n",
        before=fl.as_bool("before"),
        regex=fl.as_bool("regex"),
    )


async def _reverse_source(source: AsyncIterator[bytes], separator: str,
                          before: bool, regex: bool) -> bytes:
    data = b"".join([chunk async for chunk in source])
    text = data.decode(errors="replace")
    pattern = separator if regex else re.escape(separator)
    parts = re.split(f"({pattern})", text)
    records: list[str] = []
    for index in range(0, len(parts) - 1, 2):
        records.append(parts[index + 1] +
                       parts[index] if before else parts[index] +
                       parts[index + 1])
    if len(parts) % 2 == 1 and parts[-1]:
        records.append(parts[-1])
    records.reverse()
    return "".join(records).encode()


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    separator: str = "\n",
    before: bool = False,
    regex: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        cache = [p.mount_path for p in paths]
        parts: list[bytes] = []
        for p in paths:
            parts.append(await _reverse_source(read_stream(p), separator,
                                               before, regex))
        return b"".join(parts), IOResult(cache=cache)

    source = _resolve_source(stdin)
    return await _reverse_source(source, separator, before, regex), IOResult()


async def tac_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run tac over resolved operands; mirrors tacGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by tac.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "tac")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await tac(readable,
                  read_stream=normalized_read(stream),
                  stdin=opts.stdin,
                  separator=parsed.separator,
                  before=parsed.before,
                  regex=parsed.regex), err)


__all__ = ["tac", "tac_generic"]
