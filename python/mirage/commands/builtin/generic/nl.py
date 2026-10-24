from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import reported_stream
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, chain_output, open_stream
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import PathSpec, PolymorphicReadFn

# The options mirage-rs validates as GNU does, each occurrence in the order
# the line typed them.
OPTIONS = (
    "starting_line_number",
    "line_increment",
    "number_width",
    "join_blank_lines",
    "body_numbering",
    "footer_numbering",
    "header_numbering",
    "number_format",
)


@dataclass(frozen=True, slots=True)
class NlFlags:
    """nl's options as typed: every occurrence of the ones GNU validates, in
    the order the line typed them, for the engine to validate and resolve."""

    options: tuple[tuple[str, str], ...] = ()
    separator: str = "\t"
    delimiter: str = "\\:"
    no_renumber: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> NlFlags:
    fl = FlagView(flags, spec=SPECS["nl"])
    return NlFlags(
        options=tuple(
            (dest, raw)
            for dest in fl.typed_order(*OPTIONS)
            for raw in fl.as_list(dest)
        ),
        separator=fl.as_str("number_separator", "\t"),
        delimiter=fl.as_str("section_delimiter", "\\:"),
        no_renumber=fl.as_bool("no_renumber"),
    )


async def _numbered(
    engine: OpenStream, sources: list[ByteSource], io: IOResult
) -> AsyncIterator[bytes]:
    """The inputs numbered; a counter that overflows ends the run, exit 1.

    Args:
        engine (OpenStream): the ``nl`` engine.
        sources (list[ByteSource]): the inputs, in order.
        io (IOResult): takes the overflow's line and status.
    """
    try:
        async with aclosing(chain_output(engine, sources)) as output:
            async for chunk in output:
                yield chunk
    finally:
        if engine.status():
            io.exit_code = 1
            io.stderr = await materialize(io.stderr) + engine.take_stderr()


async def nl_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run nl over resolved operands, numbering on across them; an operand
    that cannot be read is reported when nl reaches it, as GNU does, so one
    after an overflow is never named. Mirrors nlGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by nl.
        ctx (Context): Flags and stdin from the dispatcher.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``, refusing a directory.
    """
    parsed = parse_flags(ctx.flags)
    try:
        engine = open_stream(
            "nl",
            {
                "options": [
                    [dest, byte_view(raw)] for dest, raw in parsed.options
                ],
                "separator": byte_view(parsed.separator),
                "delimiter": byte_view(parsed.delimiter),
                "no_renumber": parsed.no_renumber,
                "utf8": utf8_locale(ctx.env),
                "inputs": max(1, len(paths)),
            },
        )
    except StreamRefusal as refusal:
        return None, IOResult(
            exit_code=1, stderr=f"{refusal.message}\n".encode()
        )
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin)
    sources: list[ByteSource] = [
        reported_stream(read(p), io, p, "nl") for p in paths
    ]
    return _numbered(engine, sources or [ctx.stdin or b""], io), io


__all__ = ["nl_generic"]
