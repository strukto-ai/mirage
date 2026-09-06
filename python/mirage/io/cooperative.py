"""Bound CPU work between opportunities for timers and task cancellation."""

import asyncio
import time
from collections.abc import AsyncGenerator, AsyncIterator

CHUNK_SIZE = 16 * 1024


class Checkpoint:
    """A per-consumer time budget; small reads do not schedule a timer."""

    def __init__(self) -> None:
        self._next_yield = time.monotonic() + .01

    async def run(self) -> None:
        if time.monotonic() < self._next_yield:
            return
        # A positive delay lets due timers run before this task resumes.
        await asyncio.sleep(.000001)
        self._next_yield = time.monotonic() + .01


async def chunks(
        source: bytes | AsyncIterator[bytes]) -> AsyncGenerator[bytes, None]:
    """Split even a single RAM/cache blob; close producers on cancellation."""
    checkpoint = Checkpoint()
    if isinstance(source, bytes):
        for offset in range(0, len(source), CHUNK_SIZE):
            await checkpoint.run()
            yield source[offset:offset + CHUNK_SIZE]
        return
    try:
        async for data in source:
            for offset in range(0, len(data), CHUNK_SIZE):
                await checkpoint.run()
                yield data[offset:offset + CHUNK_SIZE]
    except BaseException:
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()
        raise
