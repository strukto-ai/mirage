from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.lines import map_stream
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    reported_stream,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class UnexpandFlags:
    tabsize: int = 8
    all_spaces: bool = False
    first_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> UnexpandFlags:
    fl = FlagView(flags, spec=SPECS["unexpand"])
    return UnexpandFlags(
        tabsize=int(fl.as_str("tabs") or "8"),
        all_spaces=fl.as_bool("all"),
        first_only=fl.as_bool("first_only"),
    )


def _unexpand_line(line: str, tabsize: int, all_spaces: bool) -> str:
    if all_spaces:
        result: list[str] = []
        i = 0
        while i < len(line):
            count = 0
            while i + count < len(line) and line[i + count] == " ":
                count += 1
            if count >= tabsize:
                tabs = count // tabsize
                remainder = count % tabsize
                result.append("\t" * tabs + " " * remainder)
                i += count
            elif count > 0:
                result.append(" " * count)
                i += count
            else:
                result.append(line[i])
                i += 1
        return "".join(result)
    leading = 0
    while leading < len(line) and line[leading] == " ":
        leading += 1
    if leading >= tabsize:
        tabs = leading // tabsize
        remainder = leading % tabsize
        return "\t" * tabs + " " * remainder + line[leading:]
    return line


def _unexpand_record(line: bytes, tabsize: int, all_spaces: bool) -> bytes:
    return _unexpand_line(
        line.decode(errors="replace"), tabsize, all_spaces
    ).encode()


async def unexpand(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    tabsize: int = 8,
    all_spaces: bool = False,
    first_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    read = stdin_stream(read_stream, stdin)
    sources = [reported_stream(read(p), io, p, "unexpand") for p in paths]
    transform = partial(
        _unexpand_record,
        tabsize=tabsize,
        all_spaces=all_spaces and not first_only,
    )
    source = async_chain(sources) if paths else resolve_source(stdin)
    output = map_stream(source, transform)
    return output, io


async def unexpand_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run unexpand over resolved operands; mirrors unexpandGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by unexpand.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "unexpand")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await unexpand(
            readable,
            read_stream=stream,
            stdin=opts.stdin,
            tabsize=parsed.tabsize,
            all_spaces=parsed.all_spaces,
            first_only=parsed.first_only,
        ),
        err,
    )


__all__ = ["unexpand", "unexpand_generic"]
