from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.builtin.utils.strtol import (
    EOVERFLOW_REASON,
    ERANGE_REASON,
    unsigned_decimal,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn

_DEFAULT_WIDTH = 75
# GNU 9.7 refuses a -w past 2500.
_WIDEST = 2500


@dataclass(frozen=True, slots=True)
class FmtFlags:
    width: int | None = None
    goal: int | None = None
    prefix: str | None = None
    split_only: bool = False
    tagged: bool = False
    crown: bool = False
    uniform: bool = False


def _width_refusal(text: str, value: int | None) -> str:
    """fmt's refusal of a -w value, past its range a range error.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    reason = "" if value is None else f": {ERANGE_REASON}"
    return f"fmt: invalid width: '{quote_text(text)}'{reason}"


def _goal_refusal(text: str, value: int | None) -> str:
    """fmt's refusal of a -g value, past the width too large.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    reason = "" if value is None else f": {EOVERFLOW_REASON}"
    return f"fmt: invalid width: '{quote_text(text)}'{reason}"


def parse_flags(flags: Mapping[str, FlagValue]) -> FmtFlags:
    fl = FlagView(flags, spec=SPECS["fmt"])
    # GNU 9.7 takes -w as a decimal from 0 to 2500, then -g as one from 0
    # to that width.
    width = fl.as_number(
        "width", unsigned_decimal, _width_refusal, low=0, high=_WIDEST
    )
    goal = fl.as_number(
        "goal",
        unsigned_decimal,
        _goal_refusal,
        low=0,
        high=_DEFAULT_WIDTH if width is None else width,
    )
    return FmtFlags(
        width=width,
        goal=goal,
        prefix=fl.as_str("prefix"),
        split_only=fl.as_bool("split_only"),
        tagged=fl.as_bool("tagged_paragraph"),
        crown=fl.as_bool("crown_margin"),
        uniform=fl.as_bool("uniform_spacing"),
    )


async def fmt_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fmt over resolved operands; mirrors fmtGeneric.

    Each operand is reflowed on its own.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fmt.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    parsed = parse_flags(ctx.flags)
    readable, err = await split_readable(paths, stat, "fmt")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    config: dict[str, JsonValue] = {
        "width": parsed.width,
        "goal": parsed.goal,
        "prefix": None if parsed.prefix is None else byte_view(parsed.prefix),
        "split_only": parsed.split_only,
        "tagged": parsed.tagged,
        "crown": parsed.crown,
        "uniform": parsed.uniform,
    }
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin)
    each = partial(run_stream, "fmt", config)
    output = per_operand(readable, read, ctx.stdin, io, "fmt", each)
    return await merge_split_errors((output, io), err)


__all__ = ["fmt_generic"]
