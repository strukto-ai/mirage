from collections.abc import Mapping

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
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream, run_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn


def tabs_config(
    command: str, names: tuple[str, ...], flags: Mapping[str, FlagValue]
) -> dict[str, JsonValue] | IOResult:
    """expand's or unexpand's engine config, refused by the engine before
    any operand is resolved.

    Every ``-t`` and switch goes as typed, in typed order: ``-t``
    accumulates across occurrences into one tab list.

    Args:
        command (str): expand or unexpand, the engine and the name its
            refusals give.
        names (tuple[str, ...]): the options the command reads.
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        dict[str, JsonValue] | IOResult: the config, or the refusal.
    """
    fl = FlagView(flags, spec=SPECS[command])
    options: list[JsonValue] = [
        [name, byte_view(text)] for name, text in fl.texts(*names)
    ]
    config: dict[str, JsonValue] = {"options": options}
    try:
        open_stream(command, config)
    except StreamRefusal as refusal:
        return refused(refusal)
    return config


def expand_config(
    flags: Mapping[str, FlagValue],
) -> dict[str, JsonValue] | IOResult:
    """expand's engine config: ``tabs_config`` over ``-t`` and ``-i``.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.
    """
    return tabs_config("expand", ("tabs", "initial"), flags)


async def tabs_generic(
    command: str,
    config: Mapping[str, JsonValue],
    paths: list[PathSpec],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run expand or unexpand over resolved operands, one stream over all.

    Args:
        command (str): expand or unexpand.
        config (Mapping[str, JsonValue]): ``tabs_config``'s config.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        ctx (Context): Stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    readable, err = await split_readable(paths, stdin_stat(stat), command)
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin)
    sources = [reported_stream(read(p), io, p, command) for p in readable]
    source = async_chain(sources) if readable else resolve_source(ctx.stdin)
    output = run_stream(command, config, source)
    return await merge_split_errors((output, io), err)


async def expand_generic(
    config: Mapping[str, JsonValue],
    paths: list[PathSpec],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run expand over resolved operands; mirrors expandGeneric.

    Args:
        config (Mapping[str, JsonValue]): ``expand_config``'s config.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        ctx (Context): Stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    return await tabs_generic("expand", config, paths, ctx, stat, stream)


__all__ = [
    "expand_config",
    "expand_generic",
    "tabs_config",
    "tabs_generic",
]
