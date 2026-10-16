import pytest

from mirage.io.record_spool import RecordSpool
from mirage.io.types import materialize


@pytest.mark.asyncio
async def test_replays_empty_binary_and_large_records_backwards():
    records = [b"", b"\xff\x00", b"x" * 150000, b"tail"]
    async with RecordSpool(1) as spool:
        for record in records:
            await spool.append(record)
        assert spool.count == len(records)
        for index in range(len(records) - 1, -1, -1):
            assert await spool.read(index) == records[index]
            assert await materialize(spool.stream(index)) == records[index]
        with pytest.raises(IndexError):
            await spool.read(4)
