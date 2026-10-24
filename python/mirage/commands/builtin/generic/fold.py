from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial
from typing import Literal

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.builtin.utils.strtol import (
    ERANGE_REASON,
    ULONG_MAX,
    unsigned_decimal,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn

# GNU fold's line width when -w names none.
WIDTH = 80
# GNU 9.7 takes -w as a decimal from 1 to 2**64 - 10, so 0 and anything
# past this are out of range.
WIDTH_MAX = ULONG_MAX - 9

Count = Literal["columns", "characters", "bytes"]


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
    count: Count = "columns"


def parse_flags(flags: Mapping[str, FlagValue]) -> FoldFlags:
    fl = FlagView(flags, spec=SPECS["fold"])
    width = fl.as_number(
        "width", unsigned_decimal, _width_refusal, low=1, high=WIDTH_MAX
    )
    # The later of -b and -c wins, as in GNU 9.10.
    count: Count = "columns"
    for name in fl.typed_order("bytes", "characters"):
        count = "bytes" if name == "bytes" else "characters"
    return FoldFlags(
        width=WIDTH if width is None else width,
        break_spaces=fl.as_bool("spaces"),
        count=count,
    )


async def fold_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fold over resolved operands, GNU semantics; mirrors foldGeneric.

    Each operand is folded on its own, from column 0.

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
    config: dict[str, JsonValue] = {
        "width": parsed.width,
        "spaces": parsed.break_spaces,
        "count": parsed.count,
    }
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin)
    each = partial(run_stream, "fold", config)
    output = per_operand(readable, read, ctx.stdin, io, "fold", each)
    return await merge_split_errors((output, io), err)


__all__ = ["fold_generic"]
