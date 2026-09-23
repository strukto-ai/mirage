import inspect
from collections import deque
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.commands.builtin.tail_counts import (number_flag_error,
                                                 parse_byte_count)
from mirage.commands.builtin.utils.constants import CHAR_DEVICE_MAX_BYTES
from mirage.commands.builtin.utils.limit import truncate_stream
from mirage.commands.builtin.utils.operands import (normalized_read,
                                                    operands_io,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import (is_stdin, resolve_source,
                                                  stdin_stat, stdin_stream)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, Limit, PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.stream import ensure_stream


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
    return HeadFlags(
        lines=int(n_raw) if n_raw is not None else None,
        bytes_=parse_byte_count(c_raw) if c_raw is not None else None,
        quiet=fl.as_bool("quiet") or fl.as_bool("silent"),
        verbose=fl.as_bool("verbose"),
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def head(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
    zero_terminated: bool = False,
) -> AsyncIterator[bytes]:
    if c is not None:
        if c == 0:
            return
        if c > 0:
            emitted = 0
            async for chunk in ensure_stream(src):
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
        async for chunk in ensure_stream(src):
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
        async for chunk in ensure_stream(src):
            start = 0
            while emitted_lines < target:
                end = chunk.find(separator, start)
                if end < 0:
                    if start < len(chunk):
                        yield chunk[start:]
                    break
                yield chunk[start:end + 1]
                emitted_lines += 1
                if emitted_lines >= target:
                    return
                start = end + 1
        return

    keep = -target
    recent: deque[bytes] = deque(maxlen=keep)
    buf = b""
    async for chunk in ensure_stream(src):
        buf += chunk
        while separator in buf:
            line, buf = buf.split(separator, 1)
            if len(recent) == keep:
                yield recent[0] + separator
            recent.append(line)
    if buf:
        if len(recent) == keep:
            yield recent[0] + separator
        recent.append(buf)


def head_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    show_headers: bool = False,
    zero_terminated: bool = False,
) -> AsyncIterator[bytes]:
    """Run head over multiple already-resolved paths.

    Globs are expanded by the caller, so ``paths`` is a flat list of concrete
    entries. When ``show_headers`` is set a ``==> path <==`` banner is emitted
    before each file (POSIX/GNU head with multiple files), separated by a blank
    line between files. The per-file source is produced lazily by ``read`` so
    only one file streams at a time.

    This is a plain ``def`` returning the async generator: the cache-aware
    wrap captures the active manager now, when the command calls
    ``head_multi`` inside the mount's cache-manager scope, not when the
    returned stream is drained later (after that scope is gone). A warm read
    then returns the cached bytes; only a cold read streams lazily from the
    backend, preserving early-exit (``cat big | head -5``).

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.virtual`` is read.
        read (Callable[..., Any]): Bound reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.
    """
    cached = cache_aware_read(read)
    return _head_multi(paths,
                       read=lambda p: read(p) if is_stdin(p) else cached(p),
                       n=n,
                       c=c,
                       show_headers=show_headers,
                       zero_terminated=zero_terminated)


async def _head_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    n: int | None = None,
    c: int | None = None,
    show_headers: bool = False,
    zero_terminated: bool = False,
) -> AsyncIterator[bytes]:
    for i, p in enumerate(paths):
        if show_headers:
            label = "(standard input)" if is_stdin(p) else p.raw_path
            header = f"==> {label} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = read(p)
        if inspect.isawaitable(source):
            source = await source
        async for chunk in head(source,
                                n=n,
                                c=c,
                                zero_terminated=zero_terminated):
            yield chunk


async def head_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run head over resolved operands, GNU semantics; mirrors headGeneric.

    The wiring resolves globs and binds the backend ops (including any
    push-down, like postgres routing row reads through a LIMIT query);
    everything else lives here so factory builders and bespoke backend
    commands agree: flag parsing, the header rule, the per-operand
    report-and-continue split, and the stdin fallback. Headers count the
    operands as given (GNU heads on operand count, so a failed operand
    still forces headers on the survivors).

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by head.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    if paths:
        show_headers = (parsed.verbose or len(paths) > 1) and not parsed.quiet
        readable, err = await split_readable(paths, stat, "head")
        io = operands_io(err)
        if not readable:
            return None, io
        read = normalized_read(stream)

        def source_for(p: PathSpec) -> AsyncIterator[bytes]:
            source = read(p)

            async def bounded() -> AsyncIterator[bytes]:
                if (getattr(await stat(p), "type", None)
                        is FileType.CHAR_DEVICE and parsed.bytes_ is None):
                    async for chunk in truncate_stream(
                            source, io,
                            Limit(max_bytes=CHAR_DEVICE_MAX_BYTES)):
                        yield chunk
                    return
                async for chunk in source:
                    yield chunk

            return bounded()

        return head_multi(readable,
                          read=source_for,
                          n=parsed.lines,
                          c=parsed.bytes_,
                          show_headers=show_headers,
                          zero_terminated=parsed.zero_terminated), io
    source = resolve_source(opts.stdin, "head: missing operand")
    return head(source,
                n=parsed.lines,
                c=parsed.bytes_,
                zero_terminated=parsed.zero_terminated), IOResult()
