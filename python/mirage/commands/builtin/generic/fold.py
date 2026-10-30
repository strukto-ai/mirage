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
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.stream import run_stream
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn

# GNU fold's line width when -w names none.
WIDTH = 80

Count = Literal["columns", "characters", "bytes"]


@dataclass(frozen=True, slots=True)
class FoldFlags:
    width: int = WIDTH
    break_spaces: bool = False
    count: Count = "columns"


def parse_flags(flags: Mapping[str, FlagValue]) -> FoldFlags | IOResult:
    """fold's options, -w read by mirage-rs before any operand is resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        FoldFlags | IOResult: the flags, or fold's refusal of a -w.
    """
    fl = FlagView(flags, spec=SPECS["fold"])
    try:
        width = scan("fold", fl.texts("width")).get("width")
    except StreamRefusal as refusal:
        return refused(refusal)
    # The later of -b and -c wins, as in GNU 9.10.
    count: Count = "columns"
    for name in fl.typed_order("bytes", "characters"):
        count = "bytes" if name == "bytes" else "characters"
    return FoldFlags(
        width=width if isinstance(width, int) else WIDTH,
        break_spaces=fl.as_bool("spaces"),
        count=count,
    )


async def fold_generic(
    parsed: FoldFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fold over resolved operands, GNU semantics; mirrors foldGeneric.

    Each operand is folded on its own, from column 0.

    Args:
        parsed (FoldFlags): the options, read before the operands were.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fold.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
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


__all__ = ["fold_generic", "parse_flags"]
