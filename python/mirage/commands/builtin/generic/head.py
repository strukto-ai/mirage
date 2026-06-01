import inspect
from collections import deque
from collections.abc import AsyncIterator
from typing import Any, Callable

from mirage.types import PathSpec
from mirage.utils.stream import ensure_stream


async def head(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
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

    if target >= 0:
        if target == 0:
            return
        emitted_lines = 0
        buf = b""
        async for chunk in ensure_stream(src):
            buf += chunk
            while b"\n" in buf and emitted_lines < target:
                line, buf = buf.split(b"\n", 1)
                yield line + b"\n"
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
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if len(recent) == keep:
                yield recent[0] + b"\n"
            recent.append(line)


async def head_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    accessor: object = None,
    index: object = None,
    n: int | None = None,
    c: int | None = None,
    show_headers: bool = False,
) -> AsyncIterator[bytes]:
    """Run head over multiple already-resolved paths.

    Globs are expanded by the caller, so ``paths`` is a flat list of concrete
    entries. When ``show_headers`` is set a ``==> path <==`` banner is emitted
    before each file (POSIX/GNU head with multiple files), separated by a blank
    line between files. The per-file source is produced lazily by ``read`` so
    only one file streams at a time.

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.original`` is read.
        read (Callable[..., Any]): Reader called as ``read(accessor, path,
            index)``; returns bytes, an awaitable of bytes, or an async byte
            iterator.
        accessor (object): Backend accessor passed through to ``read``.
        index (object): Index cache store passed through to ``read``.
        n (int | None): Line count (negative = all-but-last-N, per head).
        c (int | None): Byte count.
        show_headers (bool): Emit ``==> path <==`` banners between files.
    """
    for i, p in enumerate(paths):
        if show_headers:
            header = f"==> {p.original} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = read(accessor, p, index)
        if inspect.isawaitable(source):
            source = await source
        async for chunk in head(source, n=n, c=c):
            yield chunk
