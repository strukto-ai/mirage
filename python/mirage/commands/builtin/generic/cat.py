from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.constants import CHAR_DEVICE_MAX_BYTES
from mirage.commands.builtin.utils.limit import truncate_stream
from mirage.commands.builtin.utils.operands import (
    normalized_read,
    operands_io,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.stream import async_chain, ensure_stream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import encode_text
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
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    local: bool = True,
) -> tuple[ByteSource | None, IOResult]:
    """Run cat over resolved operands, GNU semantics; mirrors catGeneric.

    The wiring resolves globs and binds the backend ops; everything else
    lives here so factory builders and bespoke backend commands agree:
    flag parsing, the per-operand report-and-continue split, and the stdin
    fallback. A single operand (and every operand on a local backend)
    streams as the consumer reads; multiple operands on a non-local
    backend are read one by one, so a read that fails after its stat is
    reported and the next operand still prints.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by cat.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        local (bool): Whether backend streams are cheap to re-open.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    parsed = parse_flags(opts.flags)
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

        async def source_for(p: PathSpec) -> AsyncIterator[bytes]:
            source = read(p)
            if stats[p.virtual].type is FileType.CHAR_DEVICE:
                source = truncate_stream(
                    source, io, Limit(max_bytes=CHAR_DEVICE_MAX_BYTES)
                )
            return source

        if len(readable) == 1:
            source: ByteSource = await source_for(readable[0])
        elif local:
            source = async_chain([await source_for(p) for p in readable])
        else:
            parts: list[bytes] = []
            for p in readable:
                try:
                    data = await materialize(await source_for(p))
                except FS_ERRORS as exc:
                    # A read the backend refuses once the stat passed (a
                    # table past its read cap) is reported like a missing
                    # operand, and the next operand still prints.
                    err += encode_text(fs_error_line("cat", p, exc))
                    continue
                parts.append(data)
            source = async_chain(parts)
        if err:
            io.stderr = err
            io.exit_code = 1
        if _wants_display(parsed):
            return display_lines(source, parsed), io
        return source, io
    source = resolve_source(opts.stdin)
    if _wants_display(parsed):
        return display_lines(source, parsed), IOResult()
    return source, IOResult()


def _visible(line: bytes, show_tabs: bool, show_nonprinting: bool) -> bytes:
    """Render a line GNU cat -T / -v style.

    Tabs become ^I under -T; under -v control bytes become ^X, DEL
    becomes ^?, and high bytes get the M- prefix with the same rules
    applied to the low seven bits. Newlines never appear here (the
    caller splits on them).

    Args:
        line (bytes): one line without its trailing newline.
        show_tabs (bool): -T, render tab as ^I.
        show_nonprinting (bool): -v, render control and high bytes.
    """
    out = bytearray()
    for byte in line:
        if byte == 9:
            out += b"^I" if show_tabs else b"\t"
        elif not show_nonprinting:
            out.append(byte)
        elif byte < 32:
            out += bytes((94, byte + 64))
        elif byte == 127:
            out += b"^?"
        elif byte >= 128:
            out += b"M-"
            low = byte - 128
            if low < 32:
                out += bytes((94, low + 64))
            elif low == 127:
                out += b"^?"
            else:
                out.append(low)
        else:
            out.append(byte)
    return bytes(out)


async def display_lines(
    source: ByteSource, parsed: CatFlags
) -> AsyncIterator[bytes]:
    """Line-process a stream for GNU cat's display flags (-n -E -T -v -s).

    Args:
        source (ByteSource): the bytes to render.
        parsed (CatFlags): the display flags.
    """
    number_lines = parsed.number_lines and not parsed.number_nonblank
    transform = parsed.show_tabs or parsed.show_nonprinting
    line_no = 0
    buf = b""
    prev_blank = False
    async for chunk in ensure_stream(source):
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if parsed.squeeze_blank and not line and prev_blank:
                prev_blank = True
                continue
            should_number = number_lines or (
                parsed.number_nonblank and bool(line)
            )
            if should_number:
                line_no += 1
            prefix = encode_text(f"{line_no:6d}\t") if should_number else b""
            suffix = b"$\n" if parsed.show_ends else b"\n"
            if transform:
                line = _visible(
                    line, parsed.show_tabs, parsed.show_nonprinting
                )
            yield prefix + line + suffix
            prev_blank = not line
    if buf:
        should_number = parsed.number_lines or parsed.number_nonblank
        if should_number:
            line_no += 1
        prefix = encode_text(f"{line_no:6d}\t") if should_number else b""
        if transform:
            buf = _visible(buf, parsed.show_tabs, parsed.show_nonprinting)
        yield prefix + buf
