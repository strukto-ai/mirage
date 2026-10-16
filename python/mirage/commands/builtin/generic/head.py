import inspect
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Collection, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.commands.builtin.tail_counts import (
    number_flag_error,
    parse_byte_count,
)
from mirage.commands.builtin.utils.constants import (
    CHAR_DEVICE_MAX_BYTES,
    STDIN_HEADER_NAME,
)
from mirage.commands.builtin.utils.limit import truncate_stream
from mirage.commands.builtin.utils.operands import (
    normalized_read,
    operands_io,
    split_opened,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    operand_label,
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.render import fs_error_line
from mirage.io.stream import async_chain, close_quietly, ensure_stream
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import encode_text
from mirage.types import FileType, Limit, PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class HeadFlags:
    lines: int | None = None
    bytes_: int | None = None
    quiet: bool = False
    verbose: bool = False
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> HeadFlags:
    fl = FlagView(flags, spec=SPECS["head"])
    n_raw = fl.as_str("lines")
    c_raw = fl.as_str("bytes")
    error = number_flag_error("head", n_raw, c_raw)
    if error is not None:
        raise ValueError(error)
    # The last of -q and -v decides, as in GNU head.
    order = fl.typed_order("quiet", "silent", "verbose")
    headers = order[-1] if order else None
    return HeadFlags(
        lines=int(n_raw) if n_raw is not None else None,
        bytes_=parse_byte_count(c_raw) if c_raw is not None else None,
        quiet=headers in ("quiet", "silent"),
        verbose=headers == "verbose",
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def head(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
    zero_terminated: bool = False,
) -> AsyncIterator[bytes]:
    """The first lines or bytes of ``src``, GNU head's cut.

    Closes ``src`` whenever it stops, at its limit, at the end of the
    input, or when its own reader stops, so a read it leaves unfinished
    releases its mount at once rather than when it is collected. It
    writes the producer's chunks on; a line count yields to the loop on
    every pull and every 64 lines, and a held line split across chunks is
    joined once.

    Args:
        src (bytes | AsyncIterator[bytes]): the input.
        n (int | None): ``-n``, lines; negative for all but the last.
        c (int | None): ``-c``, bytes; negative for all but the last.
        zero_terminated (bool): ``-z``, NUL ends a line.
    """
    stream = ensure_stream(src)
    budget = YieldBudget()
    try:
        if c is not None:
            if c == 0:
                return
            if c > 0:
                emitted = 0
                async for chunk in stream:
                    remaining = c - emitted
                    if len(chunk) >= remaining:
                        if remaining > 0:
                            yield chunk[:remaining]
                        return
                    yield chunk
                    emitted += len(chunk)
                return
            keep = -c
            buf = b""
            async for chunk in stream:
                buf += chunk
                if len(buf) > keep:
                    yield buf[:-keep]
                    buf = buf[-keep:]
            return

        target = n if n is not None else 10
        separator = b"\x00" if zero_terminated else b"\n"

        if target >= 0:
            if target == 0:
                return
            emitted_lines = 0
            async for chunk in stream:
                await budget.run()
                start = 0
                while emitted_lines < target:
                    end = chunk.find(separator, start)
                    if end < 0:
                        if start < len(chunk):
                            yield chunk[start:]
                        break
                    yield chunk[start : end + 1]
                    emitted_lines += 1
                    if emitted_lines >= target:
                        return
                    start = end + 1
                    if emitted_lines % 64 == 0:
                        await budget.run()
            return

        keep = -target
        recent: deque[bytes] = deque(maxlen=keep)
        scanned = 0
        pending: list[bytes] = []
        async for chunk in stream:
            await budget.run()
            start = 0
            end = chunk.find(separator)
            while end >= 0:
                line = chunk[start:end]
                if pending:
                    line = b"".join([*pending, line])
                    pending = []
                if len(recent) == keep:
                    yield recent[0] + separator
                recent.append(line)
                start = end + 1
                end = chunk.find(separator, start)
                scanned += 1
                if scanned % 64 == 0:
                    await budget.run()
            if start < len(chunk):
                pending.append(chunk[start:])
        if pending:
            if len(recent) == keep:
                yield recent[0] + separator
            recent.append(b"".join(pending))

    finally:
        await close_quietly(stream)


def head_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    show_headers: bool = False,
    zero_terminated: bool = False,
    unread: frozenset[str] = frozenset(),
    refused: Collection[str] = frozenset(),
) -> AsyncIterator[bytes]:
    """Run head over multiple already-resolved paths.

    Globs are expanded by the caller, so ``paths`` is a flat list of concrete
    entries. When ``show_headers`` is set a ``==> path <==`` banner is emitted
    before each file it opens (POSIX/GNU head with multiple files), separated
    by a blank line from the one before. The per-file source is produced
    lazily by ``read`` so only one file streams at a time, preserving early
    exit (``cat big | head -5``).

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.virtual`` is read.
        read (Callable[..., Any]): Bound reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.
        unread (frozenset[str]): operands that opened but do not read (a
            directory): each prints its header and nothing else.
        refused (Collection[str]): filled by ``read`` with the operands
            whose open it refused, which print no header, as GNU opens a
            file before it heads it.
    """
    return _head_multi(
        paths,
        read=read,
        n=n,
        c=c,
        show_headers=show_headers,
        zero_terminated=zero_terminated,
        unread=unread,
        refused=refused,
    )


async def _head_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    show_headers: bool = False,
    zero_terminated: bool = False,
    unread: frozenset[str] = frozenset(),
    refused: Collection[str] = frozenset(),
) -> AsyncIterator[bytes]:
    printed = False
    for p in paths:
        body: AsyncIterator[bytes] | None = None
        first: bytes | None = None
        failure: Exception | None = None
        if p.virtual not in unread:
            source = read(p)
            if inspect.isawaitable(source):
                source = await source
            body = head(source, n=n, c=c, zero_terminated=zero_terminated)
            # The first pull opens the file; a read that fails past the
            # open still prints its header before the error.
            try:
                first = await anext(body, None)
            except Exception as exc:
                failure = exc
        try:
            if show_headers and p.virtual not in refused:
                header = f"==> {operand_label(p, STDIN_HEADER_NAME)} <==\n"
                yield encode_text("\n" + header if printed else header)
                printed = True
            if failure is not None:
                raise failure
            if body is None:
                continue
            if first is not None:
                yield first
            async for chunk in body:
                yield chunk
        finally:
            if body is not None:
                await close_quietly(body)


async def head_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    first_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run head over resolved operands, GNU semantics; mirrors headGeneric.

    The wiring resolves globs and binds the backend ops; everything else
    lives here so factory builders and bespoke backend commands agree:
    flag parsing, the header rule, the per-operand report-and-continue
    split, and the stdin fallback. Headers count the operands as given
    (GNU heads on operand count, so a failed operand still forces
    headers on the survivors). A line count (``-n N``, or the default
    10) is asked of ``first_lines`` first, so a mount that can fetch the
    start of a file on its own (a ``LIMIT`` on a table) does not send
    the rest.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by head.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        first_lines (Callable[[PathSpec, int], Awaitable[bytes | None]]
            | None): the mount's ``first_lines`` called as
            ``first_lines(path, n)``; None, or an answer of None, reads
            the file.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=encode_text(str(exc)))
    if paths:
        show_headers = (parsed.verbose or len(paths) > 1) and not parsed.quiet
        opened, unread, err = await split_opened(paths, stat, "head")
        io = operands_io(err)
        if not opened:
            return None, io
        read = normalized_read(stream)
        n = parsed.lines if parsed.lines is not None else 10
        pushed = (
            first_lines is not None
            and parsed.bytes_ is None
            and not parsed.zero_terminated
            and n > 0
        )

        refused: set[str] = set()

        def source_for(p: PathSpec) -> AsyncIterator[bytes]:
            source = read(p)

            async def bounded() -> AsyncIterator[bytes]:
                try:
                    if (
                        getattr(await stat(p), "type", None)
                        is FileType.CHAR_DEVICE
                        and parsed.bytes_ is None
                    ):
                        async for chunk in truncate_stream(
                            source, io, Limit(max_bytes=CHAR_DEVICE_MAX_BYTES)
                        ):
                            yield chunk
                        return
                    if pushed and first_lines is not None and not is_stdin(p):
                        lines = await first_lines(p, n)
                        if lines is not None:
                            yield lines
                            return
                    async for chunk in source:
                        yield chunk
                except FS_ERRORS as exc:
                    # One whose open was refused prints no header; a read
                    # that fails once the stat passed (a table past its
                    # read cap) keeps it.
                    if not isinstance(exc, READ_FAILURES):
                        refused.add(p.virtual)
                    if len(opened) == 1:
                        raise
                    # It is reported, and the next operand still prints.
                    held = io.stderr if isinstance(io.stderr, bytes) else b""
                    io.stderr = held + encode_text(
                        fs_error_line("head", p, exc)
                    )
                    io.exit_code = 1
                finally:
                    await close_quietly(source)

            return bounded()

        return head_multi(
            opened,
            read=source_for,
            n=parsed.lines,
            c=parsed.bytes_,
            show_headers=show_headers,
            zero_terminated=parsed.zero_terminated,
            unread=unread,
            refused=refused,
        ), io
    source = resolve_source(opts.stdin)
    body = head(
        source,
        n=parsed.lines,
        c=parsed.bytes_,
        zero_terminated=parsed.zero_terminated,
    )
    if parsed.verbose and not parsed.quiet:
        # -v heads a stdin nobody named with the name it gives `-`.
        body = async_chain(
            [encode_text(f"==> {STDIN_HEADER_NAME} <==\n"), body]
        )
    return body, IOResult()
