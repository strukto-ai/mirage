from collections import deque
from collections.abc import AsyncIterator

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
        if c <= 0:
            return
        buf = b""
        async for chunk in ensure_stream(src):
            buf += chunk
            if len(buf) > c:
                buf = buf[-c:]
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
