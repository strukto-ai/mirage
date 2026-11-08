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
class UnexpandFlags:
    tabs: tuple[str, ...] = ()
    all_spaces: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> UnexpandFlags:
    """Read unexpand's flags once, refusing a tab list GNU refuses.

    A tab list implies -a, and --first-only overrides both (GNU 9.7).

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        ValueError: the stderr text to print, exit 1.
    """
    fl = FlagView(flags, spec=SPECS["unexpand"])
    tabs = fl.as_list("tabs")
    return UnexpandFlags(
        tabs=tuple(tabs),
        all_spaces=(fl.as_bool("all") or bool(tabs))
        and not fl.as_bool("first_only"),
    )


async def unexpand_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run unexpand over resolved operands; mirrors unexpandGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by unexpand.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    try:
        parsed = parse_flags(ctx.flags)
        engine = open_stream(
            "unexpand",
            {
                "tabs": [byte_view(tab) for tab in parsed.tabs],
                "all": parsed.all_spaces,
            },
        )
    except (ValueError, StreamRefusal) as exc:
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    try:
        order = await split_in_order(paths, stat, "unexpand")
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
                else reported_stream(read(p), io, p, "unexpand")
                for p in order
            ],
            io,
        )
        if order
        else resolve_source(ctx.stdin)
    )
    return stream_output(engine, source), io


__all__ = ["unexpand_generic"]
