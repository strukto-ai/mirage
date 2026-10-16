import asyncio
import tempfile
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any, BinaryIO

from mirage.concurrency.limiter import run_blocking
from mirage.io.cooperative import CHUNK_SIZE, chunks
from mirage.io.stream import OutputStream
from mirage.io.types import ByteSource

MEMORY_LIMIT = 1024 * 1024
IO_BUFFER_SIZE = 256 * 1024


class ByteSpool:
    """Retain replayable bytes, spilling large contents outside the event loop.

    Args:
        memory_limit (int): maximum bytes retained in memory before spilling.
    """

    def __init__(self, memory_limit: int = MEMORY_LIMIT) -> None:
        if memory_limit < 0:
            raise ValueError("spool memory limit must be nonnegative")
        self.size = 0
        self.memory_limit = memory_limit
        self._memory = bytearray()
        self._file: BinaryIO | None = None
        self._lock = asyncio.Lock()
        self._closed = False
        self._cache = b""
        self._cache_offset = 0

    async def append(self, data: bytes) -> None:
        async with self._lock:
            if self._closed:
                raise ValueError("spool is closed")
            self._cache = b""
            if (
                self._file is None
                and self.size + len(data) <= self.memory_limit
            ):
                self._memory.extend(data)
            else:
                if self._file is None:

                    def open_file() -> None:
                        self._file = tempfile.TemporaryFile(mode="w+b")
                        self._file.write(self._memory)

                    await run_blocking(open_file)
                    self._memory.clear()
                self._memory.extend(data)
                if len(self._memory) >= IO_BUFFER_SIZE:
                    await self._flush()
            self.size += len(data)

    async def _flush(self) -> None:
        if self._memory:
            await run_blocking(self._write, bytes(self._memory))
            self._memory.clear()

    def _write(self, data: bytes) -> None:
        assert self._file is not None
        self._file.seek(0, 2)
        self._file.write(data)

    async def fill(self, source: ByteSource) -> None:
        async with aclosing(chunks(source)) as stream:
            async for chunk in stream:
                await self.append(chunk)

    async def read(self, offset: int, size: int) -> bytes:
        if offset < 0 or size < 0:
            raise ValueError("spool window must be nonnegative")
        async with self._lock:
            if self._closed:
                raise ValueError("spool is closed")
            if self._file is None:
                return bytes(self._memory[offset : offset + size])
            await self._flush()
            if size > CHUNK_SIZE:
                return await run_blocking(self._read, offset, size)
            if not (
                self._cache_offset <= offset
                and offset + size <= self._cache_offset + len(self._cache)
            ):
                self._cache_offset = offset // IO_BUFFER_SIZE * IO_BUFFER_SIZE
                self._cache = await run_blocking(
                    self._read,
                    self._cache_offset,
                    max(IO_BUFFER_SIZE, offset + size - self._cache_offset),
                )
            start = offset - self._cache_offset
            return self._cache[start : start + size]

    def _read(self, offset: int, size: int) -> bytes:
        assert self._file is not None
        self._file.seek(offset)
        return self._file.read(size)

    async def stream(
        self, offset: int = 0, size: int | None = None
    ) -> AsyncIterator[bytes]:
        end = self.size if size is None else min(self.size, offset + size)
        while offset < end:
            data = await self.read(offset, min(CHUNK_SIZE, end - offset))
            if not data:
                return
            offset += len(data)
            yield data

    async def file(self) -> BinaryIO:
        """Borrow a seekable file for synchronous codecs run in a worker."""
        async with self._lock:
            if self._closed:
                raise ValueError("spool is closed")
            if self._file is None:
                self._file = await run_blocking(
                    tempfile.TemporaryFile, mode="w+b"
                )
            await self._flush()
            await run_blocking(self._file.seek, 0)
            return self._file

    async def output(self) -> ByteSource:
        """Transfer the stored contents to a reader that owns their lifetime."""
        if self.size <= self.memory_limit:
            data = await self.read(0, self.size)
            await self.close()
            return data
        return OutputStream(self.stream(), self.close)

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            self._memory.clear()
            self._cache = b""
            if self._file is not None:
                file, self._file = self._file, None
                await run_blocking(file.close)

    async def __aenter__(self) -> "ByteSpool":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


class ByteSlice:
    def __init__(self, source: ByteSpool, offset: int, size: int) -> None:
        self.source, self.offset, self.size = source, offset, size

    def stream(self) -> AsyncIterator[bytes]:
        return self.source.stream(self.offset, self.size)
