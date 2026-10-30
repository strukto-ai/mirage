import inspect
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Collection, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.commands.builtin.utils.constants import CHAR_DEVICE_MAX_BYTES
from mirage.commands.builtin.utils.limit import truncate_stream
from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.operands import (
    normalized_read,
    operands_io,
    report_fs_error,
    split_opened,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    operand_header,
    resolve_source,
    shows_headers,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.io.async_line_iterator import SharedInput
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.stream import async_chain, close_quietly, ensure_stream
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.types import FileType, Limit, PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class HeadFlags:
    lines: int | None = None
    bytes_: int | None = None
    quiet: bool = False
    verbose: bool = False
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> HeadFlags | IOResult:
    """head's options, -n and -c read by mirage-rs before any operand is
    resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        HeadFlags | IOResult: the flags, or head's refusal of a count.
    """
    fl = FlagView(flags, spec=SPECS["head"])
    try:
        values = scan("head", fl.texts("lines", "bytes"))
    except StreamRefusal as refusal:
        return refused(refusal)
    lines = values["lines"]
    bytes_ = values["bytes"]
    assert lines is None or isinstance(lines, int)
    assert bytes_ is None or isinstance(bytes_, int)
    # The last of -q and -v decides, as in GNU head.
    order = fl.typed_order("quiet", "silent", "verbose")
    headers = order[-1] if order else None
    return HeadFlags(
        lines=lines,
        bytes_=bytes_,
        quiet=headers in ("quiet", "silent"),
        verbose=headers == "verbose",
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def _count_lines(
    chunk: bytes,
    separator: bytes,
    wanted: int,
    budget: YieldBudget,
    begin: int = 0,
) -> tuple[int, int]:
    """The lines of ``chunk`` from ``begin``, at most ``wanted``, and
    where the last of them ends, just past its separator (``begin`` for
    none), counted a bounded slice at a time with a turn of the loop
    between slices, so a large chunk still lets its task be cancelled.

    Args:
        chunk (bytes): the bytes.
        separator (bytes): the one byte that ends a line.
        wanted (int): the most lines to count.
        budget (YieldBudget): the reader's budget.
        begin (int): the offset to count from.
    """
    found = 0
    end = begin
    for start in range(begin, len(chunk), CHUNK_SIZE):
        stop = start + CHUNK_SIZE
        count = chunk.count(separator, start, stop)
        if found + count < wanted:
            if count:
                found += count
                end = chunk.rfind(separator, start, stop) + 1
            await budget.run()
            continue
        at = start
        for _ in range(wanted - found):
            at = chunk.find(separator, at, stop) + 1
        return wanted, at
    return found, end


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
    writes the producer's chunks on, as much of each as it keeps in one
    piece, and a line count yields to the loop on every pull.

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
                        if isinstance(src, SharedInput) and src.seekable:
                            src.lines.unread(chunk[remaining:])
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
        separator = record_separator(zero_terminated)

        if target >= 0:
            if target == 0:
                return
            emitted_lines = 0
            async for chunk in stream:
                await budget.run()
                found, end = await _count_lines(
                    chunk, separator, target - emitted_lines, budget
                )
                emitted_lines += found
                if emitted_lines < target:
                    if chunk:
                        yield chunk
                    continue
                if isinstance(src, SharedInput) and src.seekable:
                    src.lines.unread(chunk[end:])
                yield chunk[:end]
                return
            return

        # The chunks not yet written, each with its lines, the first from
        # ``skip``: what lies before the last ``keep`` lines goes out as
        # soon as it is known.
        keep = -target
        kept: deque[tuple[bytes, int]] = deque()
        lines = 0
        skip = 0
        async for chunk in stream:
            await budget.run()
            if not chunk:
                continue
            count, _ = await _count_lines(
                chunk, separator, len(chunk) + 1, budget
            )
            kept.append((chunk, count))
            lines += count
            while lines > keep:
                first, count = kept[0]
                over = lines - keep
                if count < over or (
                    count == over and first.endswith(separator)
                ):
                    kept.popleft()
                    lines -= count
                    yield first[skip:]
                    skip = 0
                    continue
                _, end = await _count_lines(
                    first, separator, over, budget, skip
                )
                kept[0] = (first, count - over)
                lines = keep
                yield first[skip:end]
                skip = end
        if lines == keep and kept and not kept[-1][0].endswith(separator):
            # The last line lacks its separator and still counts as one,
            # so one line more is not among the last.
            while kept:
                first, count = kept.popleft()
                if count:
                    yield first[skip : first.find(separator, skip) + 1]
                    break
                yield first[skip:]
                skip = 0

    finally:
        await close_quietly(stream)


async def head_multi(
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
    printed = False
    for p in paths:
        body: AsyncIterator[bytes] | None = None
        first: bytes | None = None
        if p.virtual not in unread:
            source = read(p)
            if inspect.isawaitable(source):
                source = await source
            body = head(source, n=n, c=c, zero_terminated=zero_terminated)
            first = await anext(body, None)
        try:
            if show_headers and p.virtual not in refused:
                yield operand_header(p, printed)
                printed = True
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
    parsed: HeadFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
    first_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run head over resolved operands, GNU semantics; mirrors headGeneric.

    The wiring resolves globs and binds the backend ops; everything else
    lives here so factory builders and bespoke backend commands agree:
    the header rule, the per-operand report-and-continue
    split, and the stdin fallback. Headers count the operands as given
    (GNU heads on operand count, so a failed operand still forces
    headers on the survivors). A line count (``-n N``, or the default
    10) is asked of ``first_lines`` first, so a mount that can fetch the
    start of a file on its own (a ``LIMIT`` on a table) does not send
    the rest.

    Args:
        parsed (HeadFlags): the options, read before the operands were.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by head.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        first_lines (Callable[[PathSpec, int], Awaitable[bytes | None]]
            | None): the mount's ``first_lines`` called as
            ``first_lines(path, n)``; None, or an answer of None, reads
            the file.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, ctx.stdin)
    if paths:
        show_headers = shows_headers(parsed.verbose, parsed.quiet, len(paths))
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
            if is_stdin(p) and isinstance(ctx.stdin, SharedInput):
                return ctx.stdin
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
                    # Reported as it happens, so a reader that stops at the
                    # header still leaves the status; the next operand
                    # still prints. One whose open was refused prints no
                    # header; a read that fails once the stat passed (a
                    # table past its read cap) keeps it.
                    if not isinstance(exc, READ_FAILURES):
                        refused.add(p.virtual)
                    await report_fs_error(io, "head", p, exc)
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
    source = resolve_source(ctx.stdin)
    body = head(
        source,
        n=parsed.lines,
        c=parsed.bytes_,
        zero_terminated=parsed.zero_terminated,
    )
    if parsed.verbose and not parsed.quiet:
        # -v heads a stdin nobody named with the name it gives `-`.
        body = async_chain([operand_header(None), body])
    return body, IOResult()
