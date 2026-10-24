from collections.abc import Mapping
from dataclasses import dataclass, field

from mirage.commands.builtin.generic.expand import (
    TabStops,
    read_tab_stops,
    tab_config,
)
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
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class UnexpandFlags:
    tabs: TabStops = field(default_factory=TabStops)
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
        tabs=read_tab_stops(tabs, "unexpand"),
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
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    readable, err = await split_readable(paths, stat, "unexpand")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin)
    sources = [reported_stream(read(p), io, p, "unexpand") for p in readable]
    source = async_chain(sources) if readable else resolve_source(ctx.stdin)
    config: dict[str, JsonValue] = {
        "tabs": tab_config(parsed.tabs),
        "all": parsed.all_spaces,
    }
    output = run_stream("unexpand", config, source)
    return await merge_split_errors((output, io), err)


__all__ = ["unexpand_generic"]
