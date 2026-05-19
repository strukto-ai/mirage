from collections.abc import AsyncIterator


async def ensure_stream(
        src: bytes | AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    if isinstance(src, bytes):
        yield src
        return
    async for chunk in src:
        yield chunk


async def collect_bytes(src: bytes | AsyncIterator[bytes]) -> bytes:
    if isinstance(src, bytes):
        return src
    chunks: list[bytes] = []
    async for chunk in src:
        chunks.append(chunk)
    return b"".join(chunks)
