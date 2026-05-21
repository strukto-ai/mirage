from collections import deque
from collections.abc import AsyncIterator

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
