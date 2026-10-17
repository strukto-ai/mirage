from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.lines import map_stream
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.builtin.utils.strtol import (
    ERANGE_REASON,
    ULONG_MAX,
    xstrtoumax,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn

# GNU fold's line width when -w names none.
WIDTH = 80
# GNU 9.7 reads -w with xdectoumax(optarg, 1, SIZE_MAX - TAB_WIDTH - 1),
# so 0 and anything past this are out of range.
WIDTH_MAX = ULONG_MAX - 9


def _width_refusal(text: str, value: int | None) -> str:
    """fold's refusal of a -w value, the range clause only for a number.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    reason = "" if value is None else f": {ERANGE_REASON}"
    return f"fold: invalid number of columns: '{quote_text(text)}'{reason}"


@dataclass(frozen=True, slots=True)
class FoldFlags:
    width: int = WIDTH
    break_spaces: bool = False
    count_bytes: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> FoldFlags:
    fl = FlagView(flags, spec=SPECS["fold"])
    width = fl.as_number(
        "width", xstrtoumax, _width_refusal, low=1, high=WIDTH_MAX
    )
    return FoldFlags(
        width=WIDTH if width is None else width,
        break_spaces=fl.as_bool("spaces"),
        count_bytes=fl.as_bool("bytes"),
    )


def _fold_line(line: str, width: int, break_spaces: bool) -> str:
    if len(line) <= width:
        return line
    parts: list[str] = []
    while len(line) > width:
        if break_spaces:
            idx = line.rfind(" ", 0, width)
            if idx > 0:
                parts.append(line[: idx + 1])
                line = line[idx + 1 :]
            else:
                parts.append(line[:width])
                line = line[width:]
        else:
            parts.append(line[:width])
            line = line[width:]
    if line:
        parts.append(line)
    return "\n".join(parts)


def _fold_record(
    line: bytes, width: int, break_spaces: bool, count_bytes: bool
) -> bytes:
    if count_bytes:
        return b"\n".join(
            line[i : i + width] for i in range(0, len(line), width)
        )
    return _fold_line(
        line.decode(errors="replace"), width, break_spaces
    ).encode()


async def fold(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    width: int = WIDTH,
    break_spaces: bool = False,
    count_bytes: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    read = stdin_stream(read_stream, stdin)
    transform = partial(
        _fold_record,
        width=width,
        break_spaces=break_spaces,
        count_bytes=count_bytes,
    )
    each = partial(map_stream, transform=transform)
    return per_operand(paths, read, stdin, io, "fold", each), io


async def fold_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fold over resolved operands, GNU semantics; mirrors foldGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fold.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    parsed = parse_flags(ctx.flags)
    readable, err = await split_readable(paths, stat, "fold")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await fold(
            readable,
            read_stream=stream,
            stdin=ctx.stdin,
            width=parsed.width,
            break_spaces=parsed.break_spaces,
            count_bytes=parsed.count_bytes,
        ),
        err,
    )


__all__ = ["fold", "fold_generic"]
