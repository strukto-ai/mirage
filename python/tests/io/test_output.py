import asyncio

import pytest

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.errors import PipeClosed
from mirage.io.output import OutputPipe
from mirage.io.pipe import CAPACITY


@pytest.mark.asyncio
@pytest.mark.parametrize("close", [False, True])
async def test_drain_waits_for_consumption_or_reader_close(close):
    pipe = OutputPipe()
    await pipe.write("stdout", b"payload")
    pipe.end()
    events = pipe.events()
    assert (await anext(events)).data == b"payload"
    drained = asyncio.create_task(pipe.drain())
    await asyncio.sleep(0)
    assert not drained.done()
    if close:
        pipe.close_reader()
    else:
        with pytest.raises(StopAsyncIteration):
            await anext(events)
    await asyncio.wait_for(drained, 1)
    await events.aclose()


@pytest.mark.asyncio
async def test_large_output_is_bounded_and_preserves_stream_order():
    pipe = OutputPipe()
    data = b"a\x00" * CAPACITY

    async def produce():
        await pipe.write("stdout", data)
        await pipe.write("stderr", b"warning")
        await pipe.write("stdout", b"tail")
        pipe.end()

    writing = asyncio.create_task(produce())
    await asyncio.sleep(0)
    assert pipe.buffered_bytes == CAPACITY
    assert not writing.done()
    events = []
    async for event in pipe.events():
        assert len(event.data) <= CHUNK_SIZE
        assert pipe.buffered_bytes <= CAPACITY
        events.append(event)
    await writing
    assert all(event.stream == "stdout" for event in events[:-2])
    assert b"".join(event.data for event in events[:-2]) == data
    assert [(event.stream, event.data) for event in events[-2:]] == [
        ("stderr", b"warning"),
        ("stdout", b"tail"),
    ]


@pytest.mark.asyncio
async def test_close_before_read_unblocks_saturated_writer():
    pipe = OutputPipe()
    await pipe.write("stdout", b"a" * CAPACITY)
    writing = asyncio.create_task(pipe.write("stderr", b"pending"))
    await asyncio.sleep(0)
    assert not writing.done()
    pipe.close_reader()
    pipe.close_reader()
    with pytest.raises(PipeClosed):
        await asyncio.wait_for(writing, 1)
    assert pipe.buffered_bytes == 0
    assert [event async for event in pipe.events()] == []
    with pytest.raises(PipeClosed):
        await pipe.write("stdout", b"late")


@pytest.mark.asyncio
async def test_close_releases_pending_read():
    pipe = OutputPipe()
    events = pipe.events()
    pending = asyncio.create_task(anext(events))
    await asyncio.sleep(0)
    pipe.close_reader()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(pending, 1)
    await events.aclose()


@pytest.mark.asyncio
async def test_late_failure_follows_accepted_stream_events():
    pipe = OutputPipe()
    await pipe.write("stdout", b"prefix")
    await pipe.write("stderr", b"warning")
    pipe.end(ValueError("late failure"))
    events = pipe.events()
    assert (await anext(events)).stream == "stdout"
    assert (await anext(events)).stream == "stderr"
    with pytest.raises(ValueError, match="late failure"):
        await anext(events)


@pytest.mark.asyncio
async def test_writer_end_preserves_accepted_tags_and_rejects_pending_write():
    pipe = OutputPipe()
    await pipe.write("stdout", b"a" * CAPACITY)
    writing = asyncio.create_task(pipe.write("stderr", b"pending"))
    await asyncio.sleep(0)
    pipe.end()
    with pytest.raises(PipeClosed):
        await writing
    events = [event async for event in pipe.events()]
    assert sum(len(event.data) for event in events) == CAPACITY
    assert all(event.stream == "stdout" for event in events)


@pytest.mark.asyncio
async def test_second_reader_does_not_close_first_reader():
    pipe = OutputPipe()
    await pipe.write("stdout", b"first")
    events = pipe.events()
    assert (await anext(events)).data == b"first"
    with pytest.raises(RuntimeError, match="already has a reader"):
        await anext(pipe.events())
    assert not pipe.closed_reader
    await pipe.write("stderr", b"last")
    pipe.end()
    remaining = [event async for event in events]
    assert [(event.stream, event.data) for event in remaining] == [
        ("stderr", b"last")
    ]


@pytest.mark.asyncio
async def test_abandoning_events_unblocks_writer():
    pipe = OutputPipe()
    writing = asyncio.create_task(pipe.write("stdout", b"a" * CAPACITY * 3))
    events = pipe.events()
    assert len((await anext(events)).data) == CHUNK_SIZE
    await events.aclose()
    with pytest.raises(PipeClosed):
        await asyncio.wait_for(writing, 1)
    assert pipe.closed_reader


@pytest.mark.asyncio
async def test_cancelled_write_does_not_mislabel_later_stderr():
    pipe = OutputPipe()
    writing = asyncio.create_task(pipe.write("stdout", b"a" * CAPACITY * 2))
    await asyncio.sleep(0)
    writing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await writing

    async def finish():
        await pipe.write("stderr", b"warning")
        pipe.end()

    finishing = asyncio.create_task(finish())
    events = [event async for event in pipe.events()]
    await finishing
    assert all(event.stream == "stdout" for event in events[:-1])
    assert sum(len(event.data) for event in events[:-1]) == CAPACITY
    assert (events[-1].stream, events[-1].data) == ("stderr", b"warning")


@pytest.mark.asyncio
async def test_concurrent_writes_keep_each_stream_in_acceptance_order():
    pipe = OutputPipe()
    first = asyncio.create_task(pipe.write("stdout", b"a" * CAPACITY * 2))
    await asyncio.sleep(0)
    second = asyncio.create_task(pipe.write("stderr", b"warning"))

    async def finish():
        await asyncio.gather(first, second)
        pipe.end()

    finishing = asyncio.create_task(finish())
    events = [event async for event in pipe.events()]
    await finishing
    assert all(event.stream == "stdout" for event in events[:-1])
    assert sum(len(event.data) for event in events[:-1]) == CAPACITY * 2
    assert (events[-1].stream, events[-1].data) == ("stderr", b"warning")
