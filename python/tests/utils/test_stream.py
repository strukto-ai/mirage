import pytest

from mirage.utils.stream import collect_bytes, ensure_stream


@pytest.mark.asyncio
async def test_ensure_stream_from_bytes():
    chunks = [c async for c in ensure_stream(b"hello")]
    assert chunks == [b"hello"]


@pytest.mark.asyncio
async def test_ensure_stream_from_iterator():

    async def src():
        yield b"foo"
        yield b"bar"

    chunks = [c async for c in ensure_stream(src())]
    assert chunks == [b"foo", b"bar"]


@pytest.mark.asyncio
async def test_collect_bytes_from_bytes():
    assert await collect_bytes(b"hello") == b"hello"


@pytest.mark.asyncio
async def test_collect_bytes_from_iterator():

    async def src():
        yield b"foo"
        yield b"bar"

    assert await collect_bytes(src()) == b"foobar"
