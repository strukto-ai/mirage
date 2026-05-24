import pytest

from mirage.core.databricks_volume.stream import range_read, read_stream
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_read_stream_chunks_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    chunks = [
        chunk async for chunk in read_stream(accessor, path, chunk_size=2)
    ]
    assert chunks == [b"ab", b"cd", b"ef"]


@pytest.mark.asyncio
async def test_range_read_uses_end_exclusive(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    result = await range_read(accessor, path, 1, 4)
    assert result == b"bcd"


@pytest.mark.asyncio
async def test_range_read_uses_single_databricks_range_request(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await range_read(accessor, path, 1, 4)

    assert result == b"bcd"
    assert files.download_calls == []
    assert len(accessor.client.api_client.do_calls) == 1
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=1-3")


@pytest.mark.asyncio
async def test_read_stream_does_not_download_whole_file_before_yielding(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    chunks = [
        chunk async for chunk in read_stream(accessor, path, chunk_size=2)
    ]

    assert chunks == [b"ab", b"cd", b"ef"]
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls
