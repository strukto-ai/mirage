import asyncio

import pytest

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY, BytePipe


@pytest.mark.asyncio
@pytest.mark.parametrize("capacity", [CHUNK_SIZE, CAPACITY, 262144])
async def test_large_write_waits_at_capacity_and_preserves_bytes(capacity):
    pipe = BytePipe(capacity)
    data = b"a" * (capacity * 3 + 7)
    writing = asyncio.create_task(pipe.write(data))
    await asyncio.sleep(0)
    assert pipe.buffered_bytes == capacity
    assert not writing.done()

    async def produce():
        await writing
        pipe.end()

    finishing = asyncio.create_task(produce())
    parts = []
    async for part in pipe.stream():
        assert len(part) <= CHUNK_SIZE
        assert pipe.buffered_bytes <= capacity
        parts.append(part)
    await finishing
    assert b"".join(parts) == data


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["reader", "writer"])
async def test_close_wakes_a_blocked_writer(endpoint):
    pipe = BytePipe()
    await pipe.write(b"a" * CAPACITY)
    writing = asyncio.create_task(pipe.write(b"b"))
    await asyncio.sleep(0)
    assert not writing.done()
    if endpoint == "reader":
        pipe.close_reader()
    else:
        pipe.end()
    with pytest.raises(PipeClosed):
        await asyncio.wait_for(writing, 1)


@pytest.mark.asyncio
async def test_reader_close_wakes_a_parked_reader():
    pipe = BytePipe()
    reading = asyncio.create_task(anext(pipe.stream()))
    await asyncio.sleep(0)
    pipe.close_reader()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(reading, 1)


@pytest.mark.asyncio
async def test_late_failure_follows_buffered_output():
    pipe = BytePipe()
    await pipe.write(b"prefix")
    pipe.end(ValueError("late failure"))
    source = pipe.stream()
    assert await anext(source) == b"prefix"
    with pytest.raises(ValueError, match="late failure"):
        await anext(source)


@pytest.mark.asyncio
async def test_early_reader_exit_releases_a_blocked_writer():
    pipe = BytePipe()
    writing = asyncio.create_task(pipe.write(b"x" * (2 * CAPACITY)))
    source = pipe.stream()
    assert len(await anext(source)) == CHUNK_SIZE
    await source.aclose()
    with pytest.raises(PipeClosed):
        await asyncio.wait_for(writing, 1)
