import binascii
import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error, read_fail_exit_code
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, ReadBytesFn, ReadStreamFn
from mirage.utils.errors import FS_ERRORS, fs_error_line

# xxd's exit for an OUTFILE it cannot open, and for a dump that seeks
# backwards on a stream (vim's xxd 2024-12-07).
OPEN_OUTPUT_EXIT = 3
SEEK_BACK_EXIT = 5
# The most NUL bytes one chunk carries when a dump's offset skips ahead.
GAP_CHUNK = 65536


async def _xxd_dump_stream(
    source: AsyncIterator[bytes], cols: int, group: int, uppercase: bool
) -> AsyncIterator[bytes]:
    fmt = "{:02X}" if uppercase else "{:02x}"
    offset_fmt = "{:08X}: " if uppercase else "{:08x}: "
    offset = 0
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
                + f"{hex_part:<{cols * 2 + (cols // group) - 1}}  {ascii_part}\n"
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
            offset_fmt.format(offset)
            + f"{hex_part:<{cols * 2 + (cols // group) - 1}}  {ascii_part}\n"
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
) -> AsyncIterator[tuple[int | None, bytes]]:
    """Decode a hexdump into runs of bytes and the offsets they go to.

    A plain (``-p``) dump has no offsets, so its one run continues from
    the start; a character that is not a hex digit ends its line, and the
    digits pair across lines.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
    """
    buf = b""
    async for chunk in source:
        buf += chunk
    text = buf.decode(errors="replace")
    if ":" in text:
        for line in split_lines(text):
            if line:
                yield _reverse_line(line)
    else:
        kept = (
            re.match(r"[0-9A-Fa-f\s]*", line) for line in split_lines(text)
        )
        digits = "".join(m.group() for m in kept if m is not None)
        yield None, _unhex(re.sub(r"\s+", "", digits))


async def _xxd_reverse_stream(
    source: AsyncIterator[bytes], io: IOResult | None = None
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
    async for offset, data in _reverse_runs(source):
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
) -> list[tuple[int, bytes]]:
    """Revert a hexdump into the stretches xxd writes into OUTFILE.

    Each run lands at its offset, or where the last one ended; runs that
    meet join one stretch, so a whole dump is one write at 0.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
    """
    segments: list[tuple[int, bytearray]] = []
    position = 0
    async for offset, data in _reverse_runs(source):
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


async def _apply_limits(
    source: AsyncIterator[bytes], skip: int, limit: int
) -> AsyncIterator[bytes]:
    pos = 0
    remaining = limit
    async for chunk in source:
        chunk_len = len(chunk)
        if pos + chunk_len <= skip:
            pos += chunk_len
            continue
        if pos < skip:
            chunk = chunk[skip - pos :]
            pos = skip
        if remaining <= 0:
            break
        if len(chunk) > remaining:
            chunk = chunk[:remaining]
        yield chunk
        remaining -= len(chunk)
        pos += len(chunk)


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
    skip: int = 0,
    limit: int = 0,
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
    """
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.XXD, paths[2].raw_path or paths[2].virtual
        )
    if paths:
        source: AsyncIterator[bytes] = stdin_stream(read_stream, stdin)(
            paths[0]
        )
    else:
        source = resolve_source(stdin)

    if skip or limit:
        if not limit:
            limit = 2**63
        source = _apply_limits(source, skip, limit)

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
        )
    io = IOResult()
    if reverse:
        return _xxd_reverse_stream(source, io), io
    if plain:
        return _xxd_plain_stream(source, uppercase=uppercase), io
    return _xxd_dump_stream(
        source, cols=cols, group=group, uppercase=uppercase
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
) -> tuple[ByteSource | None, IOResult]:
    """Write the dump (or with ``-r`` the bytes) to OUTFILE.

    INFILE is read first, as xxd opens it first.

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
    """
    target = paths[1]
    segments: list[tuple[int, bytes]] = []
    data = b""
    try:
        if reverse:
            segments = await _reverse_segments(source)
        elif plain:
            data = await materialize(
                _xxd_plain_stream(source, uppercase=uppercase)
            )
        else:
            data = await materialize(
                _xxd_dump_stream(
                    source, cols=cols, group=group, uppercase=uppercase
                )
            )
    except FS_ERRORS as exc:
        return None, IOResult(
            stderr=fs_error_line("xxd", paths[0], exc).encode(),
            exit_code=read_fail_exit_code("xxd", exc),
        )
    if reverse and pwrite_bytes is not None:
        try:
            for start, chunk in segments or [(0, b"")]:
                await pwrite_bytes(target, chunk, start)
        except FS_ERRORS as exc:
            return None, IOResult(
                stderr=fs_error_line("xxd", target, exc).encode(),
                exit_code=OPEN_OUTPUT_EXIT,
            )
        # The stretches are not the file, so the cache drops what it holds.
        return None, IOResult(writes={target.mount_path: b""})
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
        return None, IOResult(
            stderr=b"xxd: output is not writable on this backend\n",
            exit_code=OPEN_OUTPUT_EXIT,
        )
    try:
        await write_bytes(target, data)
    except FS_ERRORS as exc:
        return None, IOResult(
            stderr=fs_error_line("xxd", target, exc).encode(),
            exit_code=OPEN_OUTPUT_EXIT,
        )
    return None, IOResult(
        writes={target.mount_path: data}, cache=[target.mount_path]
    )


__all__ = ["xxd"]


@dataclass(frozen=True, slots=True)
class XxdFlags:
    reverse: bool = False
    plain: bool = False
    uppercase: bool = False
    cols: int = 16
    group: int = 2
    skip: int = 0
    limit: int = 0


def _count(value: FlagValue | None, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return default
    if not value:
        return default
    return int(value)


def parse_flags(flags: Mapping[str, FlagValue]) -> XxdFlags:
    fl = FlagView(flags, spec=SPECS["xxd"])
    return XxdFlags(
        reverse=fl.as_bool("r"),
        plain=fl.as_bool("p"),
        uppercase=fl.as_bool("u"),
        cols=_count(fl.raw("c"), 16),
        group=_count(fl.raw("g"), 2),
        skip=_count(fl.raw("s"), 0),
        limit=_count(fl.raw("args_l"), 0),
    )


async def xxd_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_stream: ReadStreamFn,
    read_bytes: ReadBytesFn | None = None,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    pwrite_bytes: Callable[..., Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await xxd(
        paths,
        read_stream=read_stream,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        pwrite_bytes=pwrite_bytes,
        stdin=opts.stdin,
        reverse=parsed.reverse,
        plain=parsed.plain,
        uppercase=parsed.uppercase,
        cols=parsed.cols,
        group=parsed.group,
        skip=parsed.skip,
        limit=parsed.limit,
    )
