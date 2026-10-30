from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.stream import run_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class FmtFlags:
    width: int | None = None
    goal: int | None = None
    prefix: str | None = None
    split_only: bool = False
    tagged: bool = False
    crown: bool = False
    uniform: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> FmtFlags | IOResult:
    """fmt's options, -w and -g read by mirage-rs before any operand is
    resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        FmtFlags | IOResult: the flags, or fmt's refusal of a width.
    """
    fl = FlagView(flags, spec=SPECS["fmt"])
    try:
        values = scan("fmt", fl.texts("width", "goal"))
    except StreamRefusal as refusal:
        return refused(refusal)
    width, goal = values.get("width"), values.get("goal")
    return FmtFlags(
        width=width if isinstance(width, int) else None,
        goal=goal if isinstance(goal, int) else None,
        prefix=fl.as_str("prefix"),
        split_only=fl.as_bool("split_only"),
        tagged=fl.as_bool("tagged_paragraph"),
        crown=fl.as_bool("crown_margin"),
        uniform=fl.as_bool("uniform_spacing"),
    )


async def fmt_generic(
    parsed: FmtFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fmt over resolved operands; mirrors fmtGeneric.

    Each operand is reflowed on its own.

    Args:
        parsed (FmtFlags): the options, read before the operands were.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fmt.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
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


__all__ = ["fmt_generic", "parse_flags"]
