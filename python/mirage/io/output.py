import asyncio
from collections import deque
from collections.abc import AsyncGenerator

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.pipe import CAPACITY, BytePipe
from mirage.io.types import OutputEvent, StreamName


class OutputPipe:
    """One ordered output reader, sharing the byte pipe's capacity and chunks."""

    def __init__(self, capacity: int = CAPACITY) -> None:
        self._pipe = BytePipe(capacity)
        self._streams: deque[StreamName] = deque()
        self._lock = asyncio.Lock()
        self._reading = False

    @property
    def buffered_bytes(self) -> int:
        return self._pipe.buffered_bytes

    @property
    def closed_reader(self) -> bool:
        return self._pipe.closed_reader

    async def write(self, stream: StreamName, data: bytes) -> None:
        """Accept one write in order, waiting for byte capacity.

        Args:
            stream (StreamName): stdout or stderr.
            data (bytes): output bytes; empty writes have no event.
        """
        async with self._lock:
            for offset in range(0, len(data), CHUNK_SIZE):
                self._streams.append(stream)
                try:
                    await self._pipe.write(data[offset : offset + CHUNK_SIZE])
                except BaseException:
                    if self._streams:
                        self._streams.pop()
                    raise

    def end(self, error: BaseException | None = None) -> None:
        """End output, preserving accepted events before a late failure."""
        self._pipe.end(error)

    async def drain(self) -> None:
        """Wait for accepted events to be consumed or the reader to close."""
        await self._pipe.drain()

    def close_reader(self) -> None:
        """Discard unread output and wake pending readers and writers."""
        self._pipe.close_reader()
        self._streams.clear()

    async def events(self) -> AsyncGenerator[OutputEvent, None]:
        """Read once; close the reader before closing a pending iterator pull."""
        if self._reading:
            raise RuntimeError("output pipe already has a reader")
        self._reading = True
        try:
            async for data in self._pipe.stream():
                if self.closed_reader:
                    return
                yield OutputEvent(self._streams.popleft(), data)
        finally:
            self.close_reader()
