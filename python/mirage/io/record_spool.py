from collections.abc import AsyncIterator, Iterable
from typing import Any

from mirage.io.spool import MEMORY_LIMIT, ByteSpool
from mirage.io.types import ByteSource


class RecordSpool:
    """Replay variable-length records without retaining their byte offsets in RAM.

    Args:
        memory_limit (int): memory budget for each of the data and offset stores.
    """

    def __init__(self, memory_limit: int = MEMORY_LIMIT) -> None:
        self.data = ByteSpool(memory_limit)
        self.index = ByteSpool(memory_limit)
        self.count = 0

    async def append(self, record: bytes) -> None:
        offset = self.data.size
        await self.data.append(record)
        await self._index(offset, len(record))

    async def _index(self, offset: int, size: int) -> None:
        await self.index.append(
            offset.to_bytes(8, "little") + size.to_bytes(8, "little")
        )
        self.count += 1

    async def index_delimited(self, separator: bytes) -> None:
        if self.count or len(separator) != 1:
            raise ValueError(
                "record index requires an empty index and one-byte separator"
            )
        start = offset = 0
        async for chunk in self.data.stream():
            position = 0
            while (found := chunk.find(separator, position)) >= 0:
                end = offset + found + 1
                await self._index(start, end - start)
                start, position = end, found + 1
            offset += len(chunk)
        if start < self.data.size:
            await self._index(start, self.data.size - start)

    async def window(self, index: int) -> tuple[int, int]:
        if not 0 <= index < self.count:
            raise IndexError("record index out of range")
        entry = await self.index.read(index * 16, 16)
        return int.from_bytes(entry[:8], "little"), int.from_bytes(
            entry[8:], "little"
        )

    async def read(self, index: int) -> bytes:
        offset, size = await self.window(index)
        return await self.data.read(offset, size)

    async def stream(self, index: int) -> AsyncIterator[bytes]:
        offset, size = await self.window(index)
        async for part in self.data.stream(offset, size):
            yield part

    async def close(self) -> None:
        try:
            await self.data.close()
        finally:
            await self.index.close()

    async def __aenter__(self) -> "RecordSpool":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


async def delimited(
    sources: Iterable[ByteSource], separator: bytes
) -> RecordSpool:
    """The records ``separator`` ends across ``sources`` read back to back,
    byte for byte; the last one may lack it.

    Args:
        sources (Iterable[ByteSource]): the inputs, consumed in order.
        separator (bytes): the one-byte record terminator.
    """
    records = RecordSpool()
    try:
        for source in sources:
            await records.data.fill(source)
        await records.index_delimited(separator)
    except BaseException:
        await records.close()
        raise
    return records
