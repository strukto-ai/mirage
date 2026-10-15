import pytest

from mirage.core.chroma import read, tree
from mirage.vfs.chroma import ChromaVFS
from tests.fixtures.mounted import Mounted


@pytest.mark.asyncio
async def test_read_bytes_reassembles_sorted_chunks(
    chroma_accessor, quickstart_path
):
    mount = Mounted(ChromaVFS, chroma_accessor, "/knowledge")

    assert await mount.read(quickstart_path) == b"first\nsecond"


@pytest.mark.asyncio
async def test_read_stream_yields_sorted_chunks(
    chroma_accessor, quickstart_path
):
    rows = await tree.load_tree(chroma_accessor)
    (row,) = rows["/guides"]
    chunks = [
        chunk
        async for chunk in read.read_stream(
            chroma_accessor, quickstart_path, row
        )
    ]

    assert chunks == [b"first", b"\n", b"second"]
