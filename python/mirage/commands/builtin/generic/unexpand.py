from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import split_lines_keepends
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


async def unexpand(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    tabsize: int = 8,
    all_spaces: bool = False,
    first_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if first_only:
        all_spaces = False
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            lines = split_lines_keepends(data)
            all_text.extend(
                _unexpand_line(ln, tabsize, all_spaces) for ln in lines)
        return "".join(all_text).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("unexpand: missing operand")
    lines = split_lines_keepends(raw.decode(errors="replace"))
    result = [_unexpand_line(ln, tabsize, all_spaces) for ln in lines]
    return "".join(result).encode(), IOResult()


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
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "unexpand")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await unexpand(readable,
                       read_bytes=materialized_read(stream),
                       stdin=opts.stdin,
                       tabsize=parsed.tabsize,
                       all_spaces=parsed.all_spaces,
                       first_only=parsed.first_only), err)


__all__ = ["unexpand", "unexpand_generic"]
