import pytest

from mirage.core.databricks_volume.stream import read_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_read_stream_chunks_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )
    chunks = [
        chunk async for chunk in read_stream(accessor, path, chunk_size=2)
    ]
    assert chunks == [b"ab", b"cd", b"ef"]
    # Streaming should use one download body, not one Range GET per chunk.
    assert files.download_calls == [f"{remote_root}/reports/latest.md"]
    assert len(files.requests) == 1
