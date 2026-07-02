import inspect
from collections import deque
from collections.abc import AsyncIterator
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.types import PathSpec
from mirage.utils.stream import ensure_stream


async def tail(
    src: bytes | AsyncIterator[bytes],
    *,
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
) -> AsyncIterator[bytes]:
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
    accessor: object = None,
    index: object = None,
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
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
        read (Callable[..., Any]): Reader called as ``read(accessor, path,
            index)``; returns bytes, an awaitable of bytes, or an async byte
            iterator.
        accessor (object): Backend accessor passed through to ``read``.
        index (object): Index cache store passed through to ``read``.
        n (int | None): Line count.
        c (int | None): Byte count.
        from_line (int | None): 1-based start line for ``tail -n +N``.
        show_headers (bool): Emit ``==> path <==`` banners between files.
    """
    return _tail_multi(paths,
                       read=cache_aware_read(read),
                       accessor=accessor,
                       index=index,
                       n=n,
                       c=c,
                       from_line=from_line,
                       show_headers=show_headers)


async def _tail_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    accessor: object = None,
    index: object = None,
    n: int | None = None,
    c: int | None = None,
    from_line: int | None = None,
    show_headers: bool = False,
) -> AsyncIterator[bytes]:
    for i, p in enumerate(paths):
        if show_headers:
            header = f"==> {p.display} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = read(accessor, p, index)
        if inspect.isawaitable(source):
            source = await source
        async for chunk in tail(source, n=n, c=c, from_line=from_line):
            yield chunk
