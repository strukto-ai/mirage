import inspect
from collections import deque
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.commands.builtin.tail_helper import (TailCounts, number_flag_error,
                                                 parse_counts)
from mirage.commands.builtin.utils.operands import operands_io, split_readable
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.stream import ensure_stream


@dataclass(frozen=True, slots=True)
class TailFlags:
    counts: TailCounts
    quiet: bool = False
    verbose: bool = False
    follow: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> TailFlags:
    fl = FlagView(flags, spec=SPECS["tail"])
    n_raw = fl.as_str("n")
    c_raw = fl.as_str("c")
    error = number_flag_error("tail", n_raw, c_raw)
    if error is not None:
        raise ValueError(error)
    return TailFlags(
        counts=parse_counts(n_raw, c_raw),
        quiet=fl.as_bool("q"),
        verbose=fl.as_bool("v"),
        follow=fl.as_bool("follow"),
    )


async def tail(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
) -> AsyncIterator[bytes]:
    if from_byte is not None:
        # GNU counts `-c +N` from byte N, 1-indexed, so +0 and +1 both mean
        # the whole file.
        skip = max(0, from_byte - 1)
        skipped = 0
        async for chunk in ensure_stream(src):
            if skipped >= skip:
                yield chunk
                continue
            remaining = skip - skipped
            if len(chunk) <= remaining:
                skipped += len(chunk)
                continue
            yield chunk[remaining:]
            skipped = skip
        return

    if from_line is not None:
        start = max(1, from_line)
        skip = start - 1
        if skip == 0:
            async for chunk in ensure_stream(src):
                yield chunk
            return
        skipped = 0
        emitting = False
        async for chunk in ensure_stream(src):
            if emitting:
                yield chunk
                continue
            count = chunk.count(b"\n")
            if skipped + count < skip:
                skipped += count
                continue
            i = 0
            for _ in range(skip - skipped):
                j = chunk.find(b"\n", i)
                i = j + 1
            skipped = skip
            emitting = True
            if i < len(chunk):
                yield chunk[i:]
        return

    if c is not None:
        target_c = abs(c)
        if target_c == 0:
            return
        buf = b""
        async for chunk in ensure_stream(src):
            buf += chunk
            if len(buf) > target_c:
                buf = buf[-target_c:]
        if buf:
            yield buf
        return

    target = abs(n) if n is not None else 10
    if target == 0:
        return

    recent: deque[bytes] = deque(maxlen=target)
    buf = b""
    async for chunk in ensure_stream(src):
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            recent.append(line + b"\n")
    if buf:
        recent.append(buf)

    for line in recent:
        yield line


def tail_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
    show_headers: bool = False,
) -> AsyncIterator[bytes]:
    """Run tail over multiple already-resolved paths.

    Globs are expanded by the caller, so ``paths`` is a flat list of concrete
    entries. When ``show_headers`` is set a ``==> path <==`` banner is emitted
    before each file (POSIX/GNU tail with multiple files), separated by a blank
    line between files. The per-file source is produced lazily by ``read``.

    This is a plain ``def`` returning the async generator: the cache-aware
    wrap captures the active manager now, when the command calls
    ``tail_multi`` inside the mount's cache-manager scope, not when the
    returned stream is drained later (after that scope is gone).

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.virtual`` is read.
        read (Callable[..., Any]): Bound reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.
    """
    return _tail_multi(paths,
                       read=cache_aware_read(read),
                       n=n,
                       c=c,
                       from_line=from_line,
                       from_byte=from_byte,
                       show_headers=show_headers)


async def _tail_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    from_byte: int | None = None,
    show_headers: bool = False,
) -> AsyncIterator[bytes]:
    for i, p in enumerate(paths):
        if show_headers:
            header = f"==> {p.raw_path} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = read(p)
        if inspect.isawaitable(source):
            source = await source
        async for chunk in tail(source,
                                n=n,
                                c=c,
                                from_line=from_line,
                                from_byte=from_byte):
            yield chunk


async def tail_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run tail over resolved operands, GNU semantics; mirrors tailGeneric.

    The wiring resolves globs and binds the backend ops (including any
    push-down, like mongodb serving the last N documents server-side);
    everything else lives here: flag parsing, the header rule, the
    per-operand report-and-continue split, and the stdin fallback.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by tail.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    counts = parsed.counts
    if paths:
        show_headers = (parsed.verbose or len(paths) > 1) and not parsed.quiet
        readable, err = await split_readable(paths, stat, "tail")
        io = operands_io(err)
        if not readable:
            return None, io
        return tail_multi(readable,
                          read=stream,
                          n=counts.lines,
                          c=counts.byte_count,
                          from_line=counts.from_line,
                          from_byte=counts.from_byte,
                          show_headers=show_headers), io
    source = _resolve_source(opts.stdin, "tail: missing operand")
    return tail(source,
                n=counts.lines,
                c=counts.byte_count,
                from_line=counts.from_line,
                from_byte=counts.from_byte), IOResult()
