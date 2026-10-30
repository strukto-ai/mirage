from collections.abc import AsyncIterator, Mapping
from dataclasses import asdict, dataclass

from mirage.commands.builtin.utils.constants import CHAR_DEVICE_MAX_BYTES
from mirage.commands.builtin.utils.limit import truncate_stream
from mirage.commands.builtin.utils.operands import (
    normalized_read,
    operands_io,
    reported_stream,
    split_readable,
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
from mirage.io.stream import OutputStream, async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import open_stream
from mirage.types import (
    FileStat,
    FileType,
    Limit,
    PathSpec,
    PolymorphicReadFn,
    StatFn,
)


@dataclass(frozen=True, slots=True)
class CatFlags:
    number_lines: bool = False
    number_nonblank: bool = False
    show_ends: bool = False
    squeeze_blank: bool = False
    show_tabs: bool = False
    show_nonprinting: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> CatFlags:
    fl = FlagView(flags, spec=SPECS["cat"])
    show_all = fl.as_bool("show_all")
    return CatFlags(
        number_lines=fl.as_bool("number"),
        number_nonblank=fl.as_bool("number_nonblank"),
        show_ends=(fl.as_bool("show_ends") or fl.as_bool("e") or show_all),
        squeeze_blank=fl.as_bool("squeeze_blank"),
        show_tabs=(fl.as_bool("show_tabs") or fl.as_bool("t") or show_all),
        show_nonprinting=(
            fl.as_bool("show_nonprinting")
            or fl.as_bool("e")
            or fl.as_bool("t")
            or show_all
        ),
    )


def _wants_display(parsed: CatFlags) -> bool:
    return any(
        (
            parsed.number_lines,
            parsed.number_nonblank,
            parsed.show_ends,
            parsed.squeeze_blank,
            parsed.show_tabs,
            parsed.show_nonprinting,
        )
    )


async def cat_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run cat over resolved operands, GNU semantics; mirrors catGeneric.

    The wiring resolves globs and binds the backend ops; everything else
    lives here so factory builders and bespoke backend commands agree:
    flag parsing, the per-operand report-and-continue split, and the stdin
    fallback. Every operand streams in order as the consumer reads.
    A read that fails after its stat keeps what it printed, is reported,
    and the next operand still prints.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by cat.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, ctx.stdin)
    parsed = parse_flags(ctx.flags)
    read = normalized_read(stream)
    if paths:
        stats: dict[str, FileStat] = {}

        async def remember_stat(p: PathSpec) -> FileStat:
            row = await stat(p)
            stats[p.virtual] = row
            return row

        readable, err = await split_readable(paths, remember_stat, "cat")
        if not readable:
            return None, operands_io(err)
        io = IOResult()
        if err:
            io.stderr = err
            io.exit_code = 1

        async def source_for(p: PathSpec) -> AsyncIterator[bytes]:
            source = read(p)
            if stats[p.virtual].type is FileType.CHAR_DEVICE:
                source = truncate_stream(
                    source, io, Limit(max_bytes=CHAR_DEVICE_MAX_BYTES)
                )
            return source

        source: ByteSource = async_chain(
            [
                reported_stream(await source_for(p), io, p, "cat")
                for p in readable
            ]
        )
        if _wants_display(parsed):
            return display_lines(source, parsed), io
        return source, io
    source = resolve_source(ctx.stdin)
    if _wants_display(parsed):
        return display_lines(source, parsed), IOResult()
    return source, IOResult()


def display_lines(source: ByteSource, parsed: CatFlags) -> OutputStream:
    """Render cat's display flags in the shared byte stream.

    Args:
        source (ByteSource): The concatenated input operands.
        parsed (CatFlags): The display flags.
    """
    return stream_output(open_stream("cat", asdict(parsed)), source)
