import asyncio

import pytest

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.pipe import CAPACITY
from mirage.io.writer import ByteWriter


@pytest.mark.asyncio
async def test_writer_waits_for_capacity_and_commit():
    gate = asyncio.Event()
    committed = asyncio.Event()
    received = []

    async def consume(source):
        await gate.wait()
        async for chunk in source:
            received.append(chunk)
        committed.set()

    writer = ByteWriter(consume)
    pending = asyncio.create_task(writer.write(b"x" * (CAPACITY + CHUNK_SIZE)))
    await asyncio.sleep(0)
    assert not pending.done()
    assert writer.pipe.buffered_bytes <= CAPACITY
    assert not committed.is_set()
    gate.set()
    await pending
    assert not committed.is_set()
    await writer.finish()
    assert committed.is_set()
    assert sum(map(len, received)) == CAPACITY + CHUNK_SIZE


# A joined writer hands a busy consumer what was written meanwhile as one
# chunk, so a backend writing each chunk makes one write, not one per call.
@pytest.mark.asyncio
@pytest.mark.parametrize("joined,reads", [(False, 4), (True, 2)])
async def test_a_joined_writer_takes_what_came_while_it_was_busy(
    joined, reads
):
    gate = asyncio.Event()
    received: list[bytes] = []

    async def consume(source):
        async for chunk in source:
            received.append(chunk)
            await gate.wait()

    writer = ByteWriter(consume, joined=joined)
    await writer.write(b"a")
    await asyncio.sleep(0)
    for part in (b"b", b"c", b"d"):
        await writer.write(part)
    gate.set()
    await writer.finish()
    assert (b"".join(received), len(received)) == (b"abcd", reads)


@pytest.mark.asyncio
async def test_abort_closes_consumer_without_commit():
    entered = asyncio.Event()
    closed = asyncio.Event()
    committed = []

    async def consume(source):
        try:
            async for chunk in source:
                entered.set()
            committed.append(True)
        finally:
            closed.set()

    writer = ByteWriter(consume)
    await writer.write(b"x")
    await entered.wait()
    await writer.abort()
    assert closed.is_set()
    assert not committed


@pytest.mark.asyncio
async def test_consumer_failure_wakes_a_blocked_producer():
    error = OSError("upload failed")
    gate = asyncio.Event()

    async def consume(source):
        await gate.wait()
        raise error

    writer = ByteWriter(consume)
    pending = asyncio.create_task(writer.write(b"x" * (CAPACITY * 2)))
    await asyncio.sleep(0)
    gate.set()
    with pytest.raises(OSError, match="upload failed"):
        await pending
    await writer.abort()
