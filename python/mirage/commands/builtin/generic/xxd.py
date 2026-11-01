import struct
from collections import deque
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stream,
    stream_output,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error, read_fail_exit_code
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.cooperative import CHUNK_SIZE, chunks
from mirage.io.spool import ByteSpool
from mirage.io.stream import (
    OutputStream,
    async_chain,
    close_quietly,
    prime_stream,
    yield_bytes,
)
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.stream import open_stream, run_stream, stream_output_chunks
from mirage.types import LineFacts, PathSpec, ReadStreamFn

# xxd's exit for an OUTFILE it cannot open, for an INFILE it cannot seek
# where -s says, and for a dump that seeks backwards on a stream (vim's
# xxd 2024-12-07).
OPEN_OUTPUT_EXIT = 3
CANNOT_SEEK_EXIT = 4
SEEK_BACK_EXIT = 5
CANNOT_SEEK = b"xxd: Sorry, cannot seek.\n"


def _dump_stream(
    source: AsyncIterator[bytes],
    cols: int,
    group: int,
    uppercase: bool,
    base: int,
) -> OutputStream:
    return stream_output(
        open_stream(
            "xxd",
            {
                "mode": "dump",
                "cols": cols,
                "group": group,
                "uppercase": uppercase,
                "base": base,
            },
        ),
        source,
    )


def _plain_stream(
    source: AsyncIterator[bytes], uppercase: bool, cols: int
) -> OutputStream:
    return stream_output(
        open_stream(
            "xxd", {"mode": "plain", "uppercase": uppercase, "cols": cols}
        ),
        source,
    )


async def _xxd_reverse_stream(
    source: AsyncIterator[bytes], io: IOResult, plain: bool
) -> AsyncIterator[bytes]:
    """Revert a hexdump onto a stream, which can only move forward.

    Deliberate divergence: stdout is a stream here even when the line
    redirects it to a file, which xxd would seek, so an offset before the
    bytes written stops the dump with xxd's refusal.

    Args:
        source (AsyncIterator[bytes]): The hexdump.
        io (IOResult): The result to mark on a backward seek.
        plain (bool): -p.
    """
    stream = open_stream(
        "xxd", {"mode": "reverse", "plain": plain, "segments": False}
    )
    try:
        async with aclosing(stream_output_chunks(stream, source)) as parts:
            async for part in parts:
                yield part
    except StreamRefusal as refusal:
        if refusal.output:
            yield refusal.output
        io.exit_code = SEEK_BACK_EXIT
        io.stderr = f"{refusal.message}\n".encode()


async def _reverse_segments(
    source: ByteSource,
) -> AsyncGenerator[tuple[int, bytes], None]:
    """Decode Rust's offset/length frames one bounded write at a time."""
    frame = struct.Struct("<QQ")
    header = bytearray()
    left = 0
    start = 0
    pending = bytearray()
    pending_start = 0
    async with aclosing(chunks(source)) as parts:
        async for part in parts:
            at = 0
            while at < len(part):
                if left == 0:
                    taken = min(frame.size - len(header), len(part) - at)
                    header += part[at : at + taken]
                    at += taken
                    if len(header) < frame.size:
                        break
                    start, left = frame.unpack(header)
                    header.clear()
                    continue
                if pending and start != pending_start + len(pending):
                    yield pending_start, bytes(pending)
                    pending.clear()
                if not pending:
                    pending_start = start
                taken = min(left, len(part) - at, CHUNK_SIZE - len(pending))
                pending += part[at : at + taken]
                start += taken
                at += taken
                left -= taken
                if len(pending) == CHUNK_SIZE:
                    yield pending_start, bytes(pending)
                    pending.clear()
        if pending:
            yield pending_start, bytes(pending)


async def _patched(existing: ByteSource, segments: ByteSource) -> ByteSource:
    """Patch a spillable copy so writes never truncate an input still read."""
    stored = ByteSpool()
    budget = YieldBudget()
    try:
        try:
            await stored.fill(existing)
        except FileNotFoundError:
            await stored.close()
            stored = ByteSpool()
        async with aclosing(_reverse_segments(segments)) as writes:
            async for start, data in writes:
                end = start + len(data)
                while stored.size < end:
                    await budget.run()
                    await stored.append(
                        bytes(min(CHUNK_SIZE, end - stored.size))
                    )
                await stored.write(start, data)
        return await stored.output()
    except BaseException:
        await stored.close()
        raise


@dataclass(frozen=True, slots=True)
class XxdSeek:
    """``-s`` as xxd reads it: ``[+][-]offset``.

    ``relative`` (``+``) seeks from where INFILE stands, which is its
    start here; ``back`` (``-``) seeks back from its end.
    """

    offset: int = 0
    relative: bool = False
    back: bool = False


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
    stream: ReadStreamFn,
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
        stream (ReadStreamFn): reads INFILE, and OUTFILE for ``-r`` when
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
    read = stdin_stream(stream, stdin, sole=True)
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
            stream,
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
        return _plain_stream(source, uppercase, cols), io
    return _dump_stream(source, cols, group, uppercase, base), io


async def _write_output(
    paths: list[PathSpec],
    source: AsyncIterator[bytes],
    stream: ReadStreamFn,
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
        stream (ReadStreamFn): reads OUTFILE for ``-r``.
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
    segments: ByteSource = b""
    data: ByteSource = b""
    read_failed = False

    def failed(exc: Exception) -> None:
        nonlocal read_failed
        read_failed = True

    try:
        if reverse:
            stored = ByteSpool()
            try:
                await stored.fill(
                    run_stream(
                        "xxd",
                        {"mode": "reverse", "plain": plain, "segments": True},
                        source,
                    )
                )
                segments = await stored.output()
            except BaseException:
                await stored.close()
                raise
        else:
            data = await prime_stream(
                _plain_stream(source, uppercase, cols)
                if plain
                else _dump_stream(source, cols, group, uppercase, base),
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
            wrote = False
            async with aclosing(_reverse_segments(segments)) as writes:
                async for start, chunk in writes:
                    await pwrite_bytes(target, chunk, start)
                    wrote = True
            if not wrote:
                await pwrite_bytes(target, b"", 0)
        except FS_ERRORS as exc:
            return None, IOResult(
                stderr=fs_error_line("xxd", target, exc).encode(),
                exit_code=OPEN_OUTPUT_EXIT,
            )
        finally:
            await close_quietly(segments)
        return None, IOResult()
    if reverse:
        try:
            data = await _patched(stream(target), segments)
        except FS_ERRORS as exc:
            return None, IOResult(
                stderr=fs_error_line("xxd", target, exc).encode(),
                exit_code=OPEN_OUTPUT_EXIT,
            )
        finally:
            await close_quietly(segments)
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


def _names_output(operands: Sequence[str | PathSpec]) -> bool:
    return len(operands) > 1 or any(
        isinstance(w, PathSpec) and w.pattern is not None for w in operands
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """An xxd line writes its second operand, which a pattern the
    backend expands may name too; a quoted name is no pattern.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(writes=_names_output(operands))


__all__ = ["facts", "xxd"]


@dataclass(frozen=True, slots=True)
class XxdFlags:
    reverse: bool = False
    plain: bool = False
    uppercase: bool = False
    cols: int = 16
    group: int = 2
    seek: XxdSeek = XxdSeek()
    limit: int | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> XxdFlags | IOResult:
    """xxd's counts read by mirage-rs before any operand is resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        XxdFlags | IOResult: the flags, or xxd's refusal of a -c.
    """
    fl = FlagView(flags, spec=SPECS["xxd"])
    try:
        values = scan("xxd", fl.texts("p", "c", "g", "s", "args_l"))
    except StreamRefusal as refusal:
        return refused(refusal)
    match values:
        case {
            "cols": int(cols),
            "group": int(group),
            "seek": {
                "offset": int(offset),
                "relative": bool(relative),
                "back": bool(back),
            },
        }:
            seek = XxdSeek(offset=offset, relative=relative, back=back)
        case _:
            raise ValueError(f"xxd: unexpected scan {values}")
    limit = values.get("limit")
    return XxdFlags(
        reverse=fl.as_bool("r"),
        plain=fl.as_bool("p"),
        uppercase=fl.as_bool("u"),
        cols=cols,
        group=group,
        seek=seek,
        limit=limit if isinstance(limit, int) else None,
    )


async def xxd_generic(
    parsed: XxdFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    pwrite_bytes: Callable[..., Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await xxd(
        paths,
        stream=stream,
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
