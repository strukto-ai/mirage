import pytest

from mirage.utils.stream import ensure_stream


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
