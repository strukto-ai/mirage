import asyncio
from collections import deque
from collections.abc import AsyncIterator

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.errors import PipeClosed

CAPACITY = 4 * CHUNK_SIZE


class BytePipe:
    """One reader and bounded asynchronous writes.

    A completed write means the pipe accepted the bytes. ``drain`` waits
    for their consumption. Closing either endpoint wakes blocked writers;
    ending the producer lets the reader consume the remaining bytes first.
    """

    def __init__(self, capacity: int = CAPACITY) -> None:
        if (
            isinstance(capacity, bool)
            or not isinstance(capacity, int)
            or not CHUNK_SIZE <= capacity <= 2**53 - 1
        ):
            raise ValueError(
                "pipe capacity must be an integer from 16384 to 9007199254740991"
            )
        self._capacity = capacity
        self._chunks: deque[bytes] = deque()
        self._bytes = 0
        self._ended = False
        self._reader_closed = False
        self._reading = False
        self._delivered = 0
        self._accepted = 0
        self._failure: BaseException | None = None
        self._changed = asyncio.Event()

    @property
    def buffered_bytes(self) -> int:
        return self._bytes

    @property
    def closed_reader(self) -> bool:
        return self._reader_closed

    async def write(self, data: bytes) -> None:
        """Accept bytes in bounded chunks, waiting for available capacity.

        Args:
            data (bytes): bytes owned by the caller.
        """
        for start in range(0, len(data), CHUNK_SIZE):
            chunk = data[start : start + CHUNK_SIZE]
            while (
                self._bytes + len(chunk) > self._capacity
                and not self._reader_closed
                and not self._ended
            ):
                self._changed.clear()
                await self._changed.wait()
            if self._reader_closed or self._ended:
                raise PipeClosed()
            self._chunks.append(chunk)
            self._bytes += len(chunk)
            self._delivered += 1
            self._changed.set()

    async def drain(self) -> None:
        """Wait until the reader consumes accepted writes or closes."""
        while self._accepted < self._delivered and not self._reader_closed:
            self._changed.clear()
            await self._changed.wait()

    def end(self, error: BaseException | None = None) -> None:
        """Close the writer, preserving buffered bytes and a late failure.

        Args:
            error (BaseException | None): failure delivered after buffered bytes.
        """
        if not self._ended:
            self._failure = error
            self._ended = True
            self._changed.set()

    def close_reader(self) -> None:
        self._reader_closed = True
        self._chunks.clear()
        self._bytes = 0
        self._changed.set()

    def release(self) -> None:
        self.close_reader()

    async def stream(self) -> AsyncIterator[bytes]:
        """Read once; abandoning the iterator closes its endpoint."""
        if self._reading:
            raise RuntimeError("byte pipe already has a reader")
        self._reading = True
        try:
            while not self._reader_closed:
                if self._chunks:
                    chunk = self._chunks.popleft()
                    self._bytes -= len(chunk)
                    self._changed.set()
                    yield chunk
                    self._accepted += 1
                    self._changed.set()
                elif self._ended:
                    if self._failure is not None:
                        raise self._failure
                    return
                else:
                    self._changed.clear()
                    await self._changed.wait()
        finally:
            self.release()
