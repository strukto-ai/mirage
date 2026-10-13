import asyncio
import errno

import pytest

from mirage.core.dev.pipe import DevicePipe
from mirage.types import PathSpec

PATH = PathSpec.from_str_path("/dev/fd/63")


async def _drain(endpoint: DevicePipe, seen: list[bytes]) -> None:
    async for chunk in endpoint.stream(PATH):
        seen.append(chunk)


@pytest.mark.asyncio
async def test_end_preserves_pending_bytes_and_rejects_wrong_direction():
    endpoint = DevicePipe(True)
    await endpoint.pipe.write(b"abcdef")
    endpoint.pipe.end()
    assert await endpoint.read(PATH, 2) == b"ab"
    assert (
        b"".join([chunk async for chunk in endpoint.stream(PATH)]) == b"cdef"
    )
    with pytest.raises(OSError) as caught:
        await endpoint.write(b"x", PATH)
    assert caught.value.errno == errno.EBADF
    output = DevicePipe(False)
    with pytest.raises(OSError) as caught:
        await output.read(PATH)
    assert caught.value.errno == errno.EBADF


@pytest.mark.asyncio
async def test_concurrent_readers_take_turns_by_chunk():
    endpoint = DevicePipe(True)
    left: list[bytes] = []
    right: list[bytes] = []
    readers = asyncio.gather(_drain(endpoint, left), _drain(endpoint, right))
    for chunk in (b"one", b"two", b"three"):
        await asyncio.sleep(0)
        await endpoint.pipe.write(chunk)
    endpoint.pipe.end()
    await asyncio.wait_for(readers, 3)
    assert sorted(left + right) == [b"one", b"three", b"two"]


@pytest.mark.asyncio
async def test_abandoned_reader_keeps_the_read_end_open():
    endpoint = DevicePipe(True)
    await endpoint.pipe.write(b"first")
    await endpoint.pipe.write(b"second")
    endpoint.pipe.end()
    stream = endpoint.stream(PATH)
    assert await anext(stream) == b"first"
    await stream.aclose()
    assert not endpoint.pipe.closed_reader
    assert await endpoint.read(PATH) == b"second"


@pytest.mark.asyncio
async def test_cancelled_reader_leaves_its_chunk_to_the_next_reader():
    endpoint = DevicePipe(True)
    waiting = asyncio.create_task(endpoint.read(PATH))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await endpoint.pipe.write(b"data")
    endpoint.pipe.end()
    assert not endpoint.pipe.closed_reader
    assert await asyncio.wait_for(endpoint.read(PATH), 3) == b"data"
