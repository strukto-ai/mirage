from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (
    in_order,
    reported_stream,
    split_in_order,
)
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
    stream_output,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class ExpandFlags:
    tabs: tuple[str, ...] = ()
    initial_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> ExpandFlags:
    """Read expand's flags once, refusing a tab list GNU refuses.

    ``-t`` accumulates across occurrences, so it is declared
    ``multiple`` and read as the list it typed.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        ValueError: the stderr text to print, exit 1.
    """
    fl = FlagView(flags, spec=SPECS["expand"])
    return ExpandFlags(
        tabs=tuple(fl.as_list("tabs")),
        initial_only=fl.as_bool("initial"),
    )


async def expand_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run expand over resolved operands; mirrors expandGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by expand.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    try:
        parsed = parse_flags(ctx.flags)
        engine = open_stream(
            "expand",
            {
                "tabs": [byte_view(tab) for tab in parsed.tabs],
                "initial_only": parsed.initial_only,
            },
        )
    except (ValueError, StreamRefusal) as exc:
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    try:
        order = await split_in_order(paths, stat, "expand")
    except BaseException:
        await close_stream(engine)
        raise
    if order and all(isinstance(p, bytes) for p in order):
        await close_stream(engine)
        return None, IOResult(
            exit_code=1,
            stderr=b"".join(p for p in order if isinstance(p, bytes)),
        )
    io = IOResult(exit_code=int(any(isinstance(p, bytes) for p in order)))
    read = stdin_stream(stream, ctx.stdin)
    source = (
        in_order(
            [
                p
                if isinstance(p, bytes)
                else reported_stream(read(p), io, p, "expand")
                for p in order
            ],
            io,
        )
        if order
        else resolve_source(ctx.stdin)
    )
    return stream_output(engine, source), io


__all__ = ["ExpandFlags", "expand_generic", "parse_flags"]
