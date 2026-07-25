import inspect
from collections import deque
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.commands.builtin.tail_helper import number_flag_error
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec
from mirage.utils.stream import ensure_stream


@dataclass(frozen=True, slots=True)
class HeadFlags:
    lines: int | None = None
    bytes_: int | None = None
    quiet: bool = False
    verbose: bool = False
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, object]) -> HeadFlags:
    fl = FlagView(flags, spec=SPECS["head"])
    n_raw = fl.as_str("n") or fl.as_str("lines")
    c_raw = fl.as_str("c") or fl.as_str("bytes")
    error = number_flag_error("head", n_raw, c_raw)
    if error is not None:
        raise ValueError(error)
    return HeadFlags(
        lines=int(n_raw) if n_raw is not None else None,
        bytes_=int(c_raw) if c_raw is not None else None,
        quiet=(fl.as_bool("q") or fl.as_bool("quiet") or fl.as_bool("silent")),
        verbose=fl.as_bool("v") or fl.as_bool("verbose"),
        zero_terminated=(fl.as_bool("z") or fl.as_bool("zero_terminated")),
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
        buf = b""
        async for chunk in ensure_stream(src):
            buf += chunk
            while separator in buf and emitted_lines < target:
                line, buf = buf.split(separator, 1)
                yield line + separator
                emitted_lines += 1
            if emitted_lines >= target:
                return
        if buf and emitted_lines < target:
            yield buf
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
    return _head_multi(paths,
                       read=cache_aware_read(read),
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
            header = f"==> {p.raw_path} <==\n"
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
