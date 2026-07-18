from collections.abc import AsyncIterator


async def ensure_stream(
        src: bytes | AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    if isinstance(src, bytes):
        yield src
        return
    async for chunk in src:
        yield chunk
