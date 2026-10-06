import pytest

from mirage.core.chroma import read


@pytest.mark.asyncio
async def test_read_bytes_reassembles_sorted_chunks(
    chroma_accessor, chroma_index, quickstart_path
):
    data = await read.read(chroma_accessor, quickstart_path, chroma_index)

    assert data == b"first\nsecond"


@pytest.mark.asyncio
async def test_read_stream_yields_sorted_chunks(
    chroma_accessor, chroma_index, quickstart_path
):
    chunks = [
        chunk
        async for chunk in read.read_stream(
            chroma_accessor, quickstart_path, chroma_index
        )
    ]

    assert chunks == [b"first", b"\n", b"second"]
