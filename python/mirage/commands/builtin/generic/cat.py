from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (normalized_read,
                                                    operands_io,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain, chain_cachables
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.stream import ensure_stream


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
        show_nonprinting=(fl.as_bool("show_nonprinting") or fl.as_bool("e")
                          or fl.as_bool("t") or show_all),
    )


def _wants_display(parsed: CatFlags) -> bool:
    return any(
        (parsed.number_lines, parsed.number_nonblank, parsed.show_ends,
         parsed.squeeze_blank, parsed.show_tabs, parsed.show_nonprinting))


def _display(source: ByteSource, parsed: CatFlags) -> AsyncIterator[bytes]:
    return cat(source,
               number_lines=parsed.number_lines,
               number_nonblank=parsed.number_nonblank,
               show_ends=parsed.show_ends,
               squeeze_blank=parsed.squeeze_blank,
               show_tabs=parsed.show_tabs,
               show_nonprinting=parsed.show_nonprinting)


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
    flag parsing, the per-operand report-and-continue split, caching
    shape, and the stdin fallback. A single operand (and every operand on
    a local backend) is teed through a CachableAsyncIterator returned AS
    stdout so the cache fills as the consumer reads; multiple operands on
    a non-local backend are materialized instead, because a joined stdout
    is a different object from the per-file cachables and the cache-fill
    drain would race the consumer on the same network stream.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by cat.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        local (bool): Whether backend streams are cheap to re-open.
    """
    parsed = parse_flags(opts.flags)
    read = normalized_read(stream)
    if paths:
        readable, err = await split_readable(paths, stat, "cat")
        if not readable:
            return None, operands_io(err)
        if len(readable) == 1:
            p = readable[0]
            cachable = CachableAsyncIterator(read(p))
            io = IOResult(reads={p.mount_path: cachable}, cache=[p.mount_path])
            source: ByteSource = cachable
        elif local:
            cachables = [CachableAsyncIterator(read(p)) for p in readable]
            io = IOResult(reads={
                p.mount_path: c
                for p, c in zip(readable, cachables)
            },
                          cache=[p.mount_path for p in readable])
            source = chain_cachables(*cachables)
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in readable:
                data = await materialize(read(p))
                reads[p.mount_path] = data
                parts.append(data)
            io = IOResult(reads=reads, cache=list(reads))
            source = async_chain(*parts)
        if err:
            io.stderr = err
            io.exit_code = 1
        if _wants_display(parsed):
            return _display(source, parsed), io
        return source, io
    source = _resolve_source(opts.stdin, "cat: missing operand")
    if _wants_display(parsed):
        return _display(source, parsed), IOResult()
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


async def cat(
    src: bytes | AsyncIterator[bytes],
    *,
    number_lines: bool = False,
    number_nonblank: bool = False,
    show_ends: bool = False,
    squeeze_blank: bool = False,
    show_tabs: bool = False,
    show_nonprinting: bool = False,
) -> AsyncIterator[bytes]:
    if number_nonblank:
        number_lines = False
    needs_line_processing = (number_lines or show_ends or squeeze_blank
                             or show_tabs or show_nonprinting
                             or number_nonblank)

    if not needs_line_processing:
        async for chunk in ensure_stream(src):
            yield chunk
        return

    line_no = 0
    buf = b""
    prev_blank = False
    async for chunk in ensure_stream(src):
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if squeeze_blank and not line and prev_blank:
                prev_blank = True
                continue
            should_number = number_lines or (number_nonblank and bool(line))
            if should_number:
                line_no += 1
            prefix = f"{line_no:6d}\t".encode() if should_number else b""
            suffix = b"$\n" if show_ends else b"\n"
            if show_tabs or show_nonprinting:
                line = _visible(line, show_tabs, show_nonprinting)
            yield prefix + line + suffix
            prev_blank = not line
    if buf:
        should_number = number_lines or number_nonblank
        if should_number:
            line_no += 1
        prefix = f"{line_no:6d}\t".encode() if should_number else b""
        if show_tabs or show_nonprinting:
            buf = _visible(buf, show_tabs, show_nonprinting)
        yield prefix + buf
