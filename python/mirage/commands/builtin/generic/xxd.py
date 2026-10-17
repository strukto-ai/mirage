import binascii
import re
from collections import deque
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
)
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stream,
)
from mirage.commands.builtin.utils.strtol import c_int, strtol
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error, read_fail_exit_code
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.cooperative import chunks
from mirage.io.stream import (
    async_chain,
    close_quietly,
    prime_stream,
    yield_bytes,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, ReadBytesFn, ReadStreamFn

# xxd's exit for an OUTFILE it cannot open, for an INFILE it cannot seek
# where -s says, and for a dump that seeks backwards on a stream (vim's
# xxd 2024-12-07).
OPEN_OUTPUT_EXIT = 3
CANNOT_SEEK_EXIT = 4
SEEK_BACK_EXIT = 5
CANNOT_SEEK = b"xxd: Sorry, cannot seek.\n"
# The most octets vim's xxd puts on a line outside -p (its COLS), and its
# refusal of a -c past that or under 1.
COLS_MAX = 256
COLS_REFUSAL = f"xxd: invalid number of columns (max. {COLS_MAX})."
# The most NUL bytes one chunk carries when a dump's offset skips ahead.
GAP_CHUNK = 65536
# What a plain dump's bytes decode to, and the ones it skips.
HEX_DIGITS = {c: int(chr(c), 16) for c in b"0123456789abcdefABCDEF"}
PLAIN_BLANKS = frozenset(b" \t\r\n")


async def _xxd_dump_stream(
    source: AsyncIterator[bytes],
    cols: int,
    group: int,
    uppercase: bool,
    base: int = 0,
) -> AsyncIterator[bytes]:
    fmt = "{:02X}" if uppercase else "{:02x}"
    offset_fmt = "{:08X}: " if uppercase else "{:08x}: "
    # The hex column holds every group a full line has, the last one short
    # when ``group`` does not divide ``cols``, one blank between each.
    width = cols * 2 + -(-cols // group) - 1
    offset = base
    leftover = b""
    async for chunk in source:
        data = leftover + chunk
        i = 0
        while i + cols <= len(data):
            row = data[i : i + cols]
            hex_parts: list[str] = []
            for g in range(0, len(row), group):
                hex_parts.append(
                    "".join(fmt.format(b) for b in row[g : g + group])
                )
            hex_part = " ".join(hex_parts)
            ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
            line = (
                offset_fmt.format(offset)
                + f"{hex_part:<{width}}  {ascii_part}\n"
            )
            yield line.encode()
            offset += cols
            i += cols
        leftover = data[i:]
    if leftover:
        hex_parts = []
        for g in range(0, len(leftover), group):
            hex_parts.append(
                "".join(fmt.format(b) for b in leftover[g : g + group])
            )
        hex_part = " ".join(hex_parts)
        ascii_part = "".join(
            chr(b) if 32 <= b < 127 else "." for b in leftover
        )
        line = (
            offset_fmt.format(offset) + f"{hex_part:<{width}}  {ascii_part}\n"
        )
        yield line.encode()


async def _xxd_plain_stream(
    source: AsyncIterator[bytes], uppercase: bool
) -> AsyncIterator[bytes]:
    async for chunk in source:
        h = binascii.hexlify(chunk)
        yield h.upper() if uppercase else h
    yield b"\n"


def _unhex(digits: str) -> bytes:
    """The bytes the hex digit pairs at the start of ``digits`` spell.

    xxd stops at the first character that is not a hex digit and drops a
    digit left without its pair.

    Args:
        digits (str): Hex digits, whitespace already removed.
    """
    match = re.match(r"[0-9A-Fa-f]*", digits)
    run = match.group() if match is not None else ""
    return binascii.unhexlify(run[: len(run) // 2 * 2])


def _reverse_line(line: str) -> tuple[int | None, bytes]:
    """One hexdump line as the offset its bytes go to and the bytes.

    A line without an offset continues where the last one ended (None); a
    line whose offset is not hex decodes to nothing, as xxd skips it.

    Args:
        line (str): One line of the hexdump.
    """
    offset = None
    if ":" in line:
        head, line = line.split(":", 1)
        try:
            offset = int(head, 16)
        except ValueError:
            return None, b""
    parts = re.split(r"  +", line, maxsplit=1)
    return offset, _unhex(parts[0].replace(" ", ""))


async def _reverse_runs(
    source: AsyncIterator[bytes],
) -> AsyncGenerator[tuple[int | None, bytes], None]:
    """Decode a hexdump into runs of bytes and the offsets they go to.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
    """
    reader = AsyncLineIterator(source)
    first = True
    try:
        while True:
            raw, ended = await reader.read_until(b"\n")
            if not raw and not ended:
                return
            line = raw.decode(errors="replace")
            if first and line and ":" not in line:
                lines = [line]
                while ended:
                    rest, ended = await reader.read_until(b"\n")
                    lines.append(rest.decode(errors="replace"))
                if any(":" in row for row in lines):
                    for row in lines:
                        if row:
                            yield _reverse_line(row)
                else:
                    digits = "".join(
                        match.group()
                        for row in lines
                        if (match := re.match(r"[0-9A-Fa-f\s]*", row))
                        is not None
                    )
                    yield None, _unhex(re.sub(r"\s+", "", digits))
                return
            if line:
                first = False
                yield _reverse_line(line)
    finally:
        await reader.discard()


async def _plain_runs(
    source: AsyncIterator[bytes],
) -> AsyncGenerator[tuple[int | None, bytes], None]:
    """Decode a plain (``-p``) hexdump as it arrives, as xxd 2024-12-07 does.

    Space, tab, CR and LF never count, so two digits make a byte across
    them and across lines. Any other byte is ignored before the first
    digit and after a skipped line; past that it drops a digit left
    without its pair, and a run of them skips the rest of the line.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
    """
    high, low, lead, skip = 0, -1, True, False
    async with aclosing(chunks(source)) as parts:
        async for part in parts:
            out = bytearray()
            for c in part:
                if skip:
                    if c == 0x0A:
                        skip, lead = False, True
                    continue
                if c in PLAIN_BLANKS:
                    continue
                before, high, low = high, low, HEX_DIGITS.get(c, -1)
                if low < 0 and lead:
                    continue
                lead = False
                if high >= 0 and low >= 0:
                    out.append(high << 4 | low)
                    low = -1
                elif low < 0 and high < 0 and before < 0:
                    skip = True
            if out:
                yield None, bytes(out)


async def _xxd_reverse_stream(
    source: AsyncIterator[bytes],
    io: IOResult | None = None,
    plain: bool = False,
) -> AsyncIterator[bytes]:
    """Revert a hexdump onto a stream, which can only move forward.

    An offset past the bytes written so far is reached with NUL bytes; one
    before them cannot be, so the stream stops there with xxd's refusal.
    Deliberate divergence: stdout is a stream here even when the line
    redirects it to a file, which xxd would seek.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
        io (IOResult | None): The result to mark on a backward seek.
    """
    position = 0
    async with aclosing(
        (_plain_runs if plain else _reverse_runs)(source)
    ) as runs:
        async for offset, data in runs:
            if not data:
                continue
            if offset is not None and offset < position:
                if io is not None:
                    io.exit_code = SEEK_BACK_EXIT
                    io.stderr = b"xxd: Sorry, cannot seek backwards.\n"
                return
            while offset is not None and position < offset:
                gap = min(offset - position, GAP_CHUNK)
                yield bytes(gap)
                position += gap
            yield data
            position += len(data)


async def _reverse_segments(
    source: AsyncIterator[bytes],
    plain: bool = False,
) -> list[tuple[int, bytes]]:
    """Revert a hexdump into the stretches xxd writes into OUTFILE.

    Each run lands at its offset, or where the last one ended; runs that
    meet join one stretch, so a whole dump is one write at 0.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
    """
    segments: list[tuple[int, bytearray]] = []
    position = 0
    async with aclosing(
        (_plain_runs if plain else _reverse_runs)(source)
    ) as runs:
        async for offset, data in runs:
            if not data:
                continue
            if offset is not None:
                position = offset
            if segments and segments[-1][0] + len(segments[-1][1]) == position:
                segments[-1][1].extend(data)
            else:
                segments.append((position, bytearray(data)))
            position += len(data)
    return [(start, bytes(data)) for start, data in segments]


def _patched(existing: bytes, segments: list[tuple[int, bytes]]) -> bytes:
    """A file's bytes with the stretches written into it, as pwrite does.

    The bytes around each stretch stay, and the file grows only where one
    reaches past its end, padded with NUL.

    Args:
        existing (bytes): OUTFILE's bytes, empty when it does not exist.
        segments (list[tuple[int, bytes]]): The stretches, in order.
    """
    buf = bytearray(existing)
    for start, data in segments:
        if start > len(buf):
            buf.extend(bytes(start - len(buf)))
        buf[start : start + len(data)] = data
    return bytes(buf)


@dataclass(frozen=True, slots=True)
class XxdSeek:
    """``-s`` as xxd reads it: ``[+][-]offset``.

    ``relative`` (``+``) seeks from where INFILE stands, which is its
    start here; ``back`` (``-``) seeks back from its end.
    """

    offset: int = 0
    relative: bool = False
    back: bool = False


def parse_limit(raw: str | None) -> int | None:
    """The ``-l`` operand: None for none, and a negative count too, which
    xxd reads as no limit; ``0`` (or no number) dumps nothing.

    Args:
        raw (str | None): as typed.
    """
    if raw is None:
        return None
    limit = strtol(raw)[0]
    return None if limit < 0 else limit


def parse_seek(raw: str) -> XxdSeek:
    """The ``-s`` operand.

    Args:
        raw (str): as typed.
    """
    relative = raw.startswith("+")
    rest = raw[1:] if relative else raw
    back = rest.startswith("-")
    return XxdSeek(
        offset=strtol(rest[1:] if back else rest)[0],
        relative=relative,
        back=back,
    )


async def _past(
    source: AsyncIterator[bytes], count: int
) -> AsyncIterator[bytes] | None:
    """``source`` with its first ``count`` bytes read off, or None when
    it ends first.

    Args:
        source (AsyncIterator[bytes]): the input.
        count (int): how many bytes to read off.
    """
    stream = chunks(source)
    held = b""
    while count > 0:
        chunk = await anext(stream, None)
        if chunk is None:
            return None
        held = chunk[count:]
        count -= len(chunk) - len(held)
    return async_chain([held, stream])


async def _limited(
    source: AsyncIterator[bytes], limit: int | None
) -> AsyncIterator[bytes]:
    """``source`` cut at ``limit`` bytes, closed once they are out.

    Args:
        source (AsyncIterator[bytes]): the input.
        limit (int | None): the most to pass, None for all.
    """
    stream = chunks(source)
    left = limit
    try:
        async for chunk in stream:
            if left is not None:
                chunk = chunk[:left]
                left -= len(chunk)
            if chunk:
                yield chunk
            if left == 0:
                break
    finally:
        await stream.aclose()


async def _seeked(
    path: PathSpec | None,
    read: Callable[[PathSpec], AsyncIterator[bytes]],
    stdin: ByteSource | None,
    seek: XxdSeek,
    limit: int | None,
) -> tuple[AsyncIterator[bytes], int] | None:
    """INFILE from where ``-s`` puts it and within ``-l``, and the offset
    its first byte has; None when xxd cannot seek there.

    A file seeks: past its end it dumps nothing, before its start it
    cannot, and a seek from its end reads it whole for its size. Stdin
    cannot seek, so it is read off, and ends too soon or seeks from its
    end only to fail.

    Args:
        path (PathSpec | None): INFILE, None for stdin.
        read (Callable): the stream of INFILE, stdin for ``-``.
        stdin (ByteSource | None): the line's input.
        seek (XxdSeek): -s.
        limit (int | None): -l, None for no limit.
    """
    piped = path is None or is_stdin(path)
    source = read(path) if path is not None else resolve_source(stdin)
    if piped and seek.back:
        return None
    if not seek.back:
        start = seek.offset
    elif seek.relative:
        start = -seek.offset
    else:
        kept: deque[bytes] = deque()
        size = total = 0
        async with aclosing(chunks(source)) as data:
            async for chunk in data:
                total += len(chunk)
                kept.append(chunk)
                size += len(chunk)
                while kept and size - len(kept[0]) >= seek.offset:
                    size -= len(kept.popleft())
                if kept and size > seek.offset:
                    kept[0] = kept[0][size - seek.offset :]
                    size = seek.offset
        start = total - seek.offset
        if start < 0:
            return None
        return _limited(async_chain(list(kept)), limit), start
    if start < 0:
        return None
    past = await _past(source, start)
    if past is None:
        if piped:
            return None
        past = yield_bytes(b"")
    return _limited(past, limit), start


async def xxd(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    read_bytes: ReadBytesFn | None = None,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    pwrite_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    reverse: bool = False,
    plain: bool = False,
    uppercase: bool = False,
    cols: int = 16,
    group: int = 2,
    seek: XxdSeek | None = None,
    limit: int | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """xxd over INFILE (or stdin) to OUTFILE (or stdout).

    A dump replaces OUTFILE; ``-r`` writes into it at the dump's offsets
    and keeps the bytes around them, as xxd does, through ``pwrite`` where
    the backend has one, so the stored bytes are what it writes into and
    no gap is held here. Deliberate divergence:
    xxd opens OUTFILE before it reads, so an INFILE that is OUTFILE reads
    empty and a directory INFILE leaves an empty OUTFILE behind; this
    reads first and writes once.

    Args:
        paths (list[PathSpec]): INFILE and OUTFILE, either one ``-``.
        read_stream (Callable): reads INFILE.
        read_bytes (ReadBytesFn | None): reads OUTFILE for ``-r`` when
            there is no ``pwrite_bytes``.
        write_bytes (Callable | None): writes OUTFILE.
        pwrite_bytes (Callable | None): writes into OUTFILE at an offset.
        stdin (ByteSource | None): standard input.
        seek (XxdSeek | None): -s.
        limit (int | None): -l, None for no limit.
    """
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.XXD, paths[2].raw_path or paths[2].virtual
        )
    seek = seek or XxdSeek()
    read = stdin_stream(read_stream, stdin, sole=True)
    base = 0
    if reverse:
        source: AsyncIterator[bytes] = (
            read(paths[0]) if paths else resolve_source(stdin)
        )
        if seek.offset or limit:
            past = await _past(source, max(seek.offset, 0))
            source = _limited(past or yield_bytes(b""), limit or None)
    else:
        seeked = await _seeked(
            paths[0] if paths else None,
            read,
            stdin,
            seek,
            limit,
        )
        if seeked is None:
            return None, IOResult(
                exit_code=CANNOT_SEEK_EXIT, stderr=CANNOT_SEEK
            )
        source, base = seeked

    if len(paths) == 2 and not is_stdin(paths[1]):
        return await _write_output(
            paths,
            source,
            read_bytes,
            write_bytes,
            pwrite_bytes,
            reverse=reverse,
            plain=plain,
            uppercase=uppercase,
            cols=cols,
            group=group,
            base=base,
        )
    io = IOResult()
    if reverse:
        return _xxd_reverse_stream(source, io, plain), io
    if plain:
        return _xxd_plain_stream(source, uppercase=uppercase), io
    return _xxd_dump_stream(
        source, cols=cols, group=group, uppercase=uppercase, base=base
    ), io


async def _write_output(
    paths: list[PathSpec],
    source: AsyncIterator[bytes],
    read_bytes: ReadBytesFn | None,
    write_bytes: Callable[..., Awaitable[None]] | None,
    pwrite_bytes: Callable[..., Awaitable[None]] | None,
    *,
    reverse: bool,
    plain: bool,
    uppercase: bool,
    cols: int,
    group: int,
    base: int,
) -> tuple[ByteSource | None, IOResult]:
    """Write the dump (or with ``-r`` the bytes) to OUTFILE.

    INFILE is read first, as xxd opens it first. xxd opens OUTFILE
    before it reads, so the same file as both reads empty.

    Args:
        paths (list[PathSpec]): INFILE and OUTFILE.
        source (AsyncIterator[bytes]): INFILE's bytes, limits applied.
        read_bytes (ReadBytesFn | None): reads OUTFILE for ``-r``.
        write_bytes (Callable | None): writes OUTFILE.
        pwrite_bytes (Callable | None): writes into OUTFILE at an offset.
        reverse (bool): revert a dump instead of making one.
        plain (bool): plain hexdump style.
        uppercase (bool): uppercase hex digits.
        cols (int): octets per line.
        group (int): octets per group.
        base (int): the offset of INFILE's first byte.
    """
    target = paths[1]
    segments: list[tuple[int, bytes]] = []
    data: ByteSource = b""
    read_failed = False

    def failed(exc: Exception) -> None:
        nonlocal read_failed
        read_failed = True

    try:
        if reverse:
            segments = await _reverse_segments(source, plain)
        elif plain:
            data = await prime_stream(
                _xxd_plain_stream(source, uppercase=uppercase), failed
            )
        else:
            data = await prime_stream(
                _xxd_dump_stream(
                    source,
                    cols=cols,
                    group=group,
                    uppercase=uppercase,
                    base=base,
                ),
                failed,
            )
    except FS_ERRORS as exc:
        return None, IOResult(
            stderr=fs_error_line("xxd", paths[0], exc).encode(),
            exit_code=read_fail_exit_code("xxd", exc),
        )
    if (
        not reverse
        and not is_stdin(paths[0])
        and paths[0].virtual == target.virtual
    ):
        await close_quietly(data)
        data = b""
    if reverse and pwrite_bytes is not None:
        try:
            for start, chunk in segments or [(0, b"")]:
                await pwrite_bytes(target, chunk, start)
        except FS_ERRORS as exc:
            return None, IOResult(
                stderr=fs_error_line("xxd", target, exc).encode(),
                exit_code=OPEN_OUTPUT_EXIT,
            )
        return None, IOResult()
    if reverse:
        try:
            existing = await read_bytes(target) if read_bytes else b""
        except FileNotFoundError:
            existing = b""
        except FS_ERRORS as exc:
            return None, IOResult(
                stderr=fs_error_line("xxd", target, exc).encode(),
                exit_code=OPEN_OUTPUT_EXIT,
            )
        data = _patched(existing, segments)
    if write_bytes is None:
        await close_quietly(data)
        return None, IOResult(
            stderr=b"xxd: output is not writable on this backend\n",
            exit_code=OPEN_OUTPUT_EXIT,
        )
    try:
        await write_bytes(target, data)
    except FS_ERRORS as exc:
        return None, IOResult(
            stderr=fs_error_line(
                "xxd", paths[0] if read_failed else target, exc
            ).encode(),
            exit_code=read_fail_exit_code("xxd", exc)
            if read_failed
            else OPEN_OUTPUT_EXIT,
        )
    finally:
        await close_quietly(data)
    return None, IOResult()


__all__ = ["xxd"]


@dataclass(frozen=True, slots=True)
class XxdFlags:
    reverse: bool = False
    plain: bool = False
    uppercase: bool = False
    cols: int = 16
    group: int = 2
    seek: XxdSeek = XxdSeek()
    limit: int | None = None


def _octets(text: str) -> int:
    """A ``-c`` or ``-g`` count as xxd reads it: ``(int)strtol(text, NULL,
    0)``, so a word with no number is 0 and only its leading number counts.

    Args:
        text (str): the value as typed.
    """
    return c_int(strtol(text)[0])


def _cols_refusal(text: str, value: int | None) -> str:
    """xxd's one refusal of a -c count, whatever was typed.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to.
    """
    return COLS_REFUSAL


def _group_of(text: str | None, cols: int) -> int:
    """``-g`` as xxd settles it against the line's ``cols``.

    A negative count is the default 2, and one under 1 or past ``cols``
    is the whole line, which is how ``-g 0`` turns grouping off.

    Args:
        text (str | None): the value as typed, None when absent.
        cols (int): the octets per line.
    """
    group = 2 if text is None else _octets(text)
    if group < 0:
        group = 2
    return cols if group < 1 or group > cols else group


def parse_flags(flags: Mapping[str, FlagValue]) -> XxdFlags:
    fl = FlagView(flags, spec=SPECS["xxd"])
    plain = fl.as_bool("p")
    # -c 0 is the default, and only a dump outside -p caps the count.
    cols = fl.as_number(
        "c",
        _octets,
        _cols_refusal,
        low=0,
        high=None if plain else COLS_MAX,
    )
    cols = 16 if cols is None or cols == 0 else cols
    return XxdFlags(
        reverse=fl.as_bool("r"),
        plain=plain,
        uppercase=fl.as_bool("u"),
        cols=cols,
        group=_group_of(fl.as_text("g"), cols),
        seek=parse_seek(fl.as_str("s") or ""),
        limit=parse_limit(fl.as_str("args_l")),
    )


async def xxd_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_stream: ReadStreamFn,
    read_bytes: ReadBytesFn | None = None,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    pwrite_bytes: Callable[..., Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await xxd(
        paths,
        read_stream=read_stream,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        pwrite_bytes=pwrite_bytes,
        stdin=ctx.stdin,
        reverse=parsed.reverse,
        plain=parsed.plain,
        uppercase=parsed.uppercase,
        cols=parsed.cols,
        group=parsed.group,
        seek=parsed.seek,
        limit=parsed.limit,
    )
