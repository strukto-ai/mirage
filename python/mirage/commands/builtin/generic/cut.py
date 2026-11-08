from collections.abc import AsyncIterator, Mapping

from mirage.commands.builtin.utils.operands import (
    in_order,
    normalized_read,
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
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn

OPTIONS = (
    "bytes",
    "characters",
    "fields",
    "F",
    "delimiter",
    "no_partial",
    "complement",
    "only_delimited",
    "args_O",
    "output_delimiter",
    "w",
    "whitespace_delimited",
    "zero_terminated",
)


def cut_config(
    flags: Mapping[str, FlagValue],
) -> dict[str, JsonValue] | IOResult:
    """cut's engine config, refused by the engine before any operand is
    resolved.

    Every option goes as typed, in typed order, a switch as the empty
    text. A ``--whitespace-delimited`` without ``=`` goes as null, since
    ``--whitespace-delimited=`` reads as a prefix of ``trimmed``.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        dict[str, JsonValue] | IOResult: the config, or cut's refusal.
    """
    fl = FlagView(flags, spec=SPECS["cut"])
    options: list[JsonValue] = [
        [name, byte_view(value) if isinstance(value, str) else bare]
        for name, value in fl.occurrences(*OPTIONS)
        if value is not False
        for bare in [None if name == "whitespace_delimited" else ""]
    ]
    config: dict[str, JsonValue] = {"options": options}
    try:
        open_stream("cut", config)
    except StreamRefusal as refusal:
        return refused(refusal)
    return config


async def cut_generic(
    config: Mapping[str, JsonValue],
    paths: list[PathSpec],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run cut over resolved operands; mirrors cutGeneric.

    Args:
        config (Mapping[str, JsonValue]): ``cut_config``'s config, read
            before the operands were.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        ctx (Context): Stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as ``stream(path)``.
    """
    order = await split_in_order(paths, stdin_stat(stat), "cut")
    if order and all(isinstance(p, bytes) for p in order):
        return None, IOResult(
            exit_code=1,
            stderr=b"".join(p for p in order if isinstance(p, bytes)),
        )
    io = IOResult(exit_code=int(any(isinstance(p, bytes) for p in order)))
    if not order:
        engine = open_stream("cut", config)
        return stream_output(engine, resolve_source(ctx.stdin)), io
    read = stdin_stream(normalized_read(stream), ctx.stdin)

    async def output(path: PathSpec) -> AsyncIterator[bytes]:
        source = reported_stream(
            stream_output(open_stream("cut", config), read(path)),
            io,
            path,
            "cut",
        )
        try:
            async for chunk in source:
                yield chunk
        finally:
            await close_quietly(source)

    return in_order(
        [p if isinstance(p, bytes) else output(p) for p in order], io
    ), io


__all__ = ["cut_config", "cut_generic"]
