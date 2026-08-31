import pytest

from mirage.core.databricks_volume.stream import range_read, read_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.ranges import ByteWindow


def _path() -> PathSpec:
    return PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))


@pytest.mark.asyncio
async def test_read_stream_chunks_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    chunks = [
        chunk async for chunk in read_stream(accessor, _path(), chunk_size=2)
    ]
    assert chunks == [b"ab", b"cd", b"ef"]
    # Streaming opens one body, not one Range GET per chunk.
    assert files.stream_calls == [f"{remote_root}/reports/latest.md"]
    assert files.download_calls == []


@pytest.mark.asyncio
async def test_read_stream_missing_file_raises(accessor):
    with pytest.raises(FileNotFoundError):
        async for _ in read_stream(accessor, _path()):
            pass


@pytest.mark.asyncio
async def test_read_stream_rejects_non_positive_chunk_size(accessor):
    with pytest.raises(ValueError):
        async for _ in read_stream(accessor, _path(), chunk_size=0):
            pass


@pytest.mark.asyncio
async def test_read_stream_opens_the_body_once(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    stream = read_stream(accessor, _path(), chunk_size=2)

    first = await anext(stream)
    second = await anext(stream)

    assert first == b"ab"
    assert second == b"cd"
    assert files.stream_calls == [f"{remote_root}/reports/latest.md"]
    await stream.aclose()


@pytest.mark.asyncio
async def test_range_read_uses_end_exclusive(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    result = await range_read(accessor, _path(), 1, 4)
    assert result == b"bcd"


@pytest.mark.asyncio
async def test_range_read_uses_a_single_windowed_download(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"

    result = await range_read(accessor, _path(), 1, 4)

    assert result == b"bcd"
    assert files.stream_calls == []
    assert files.download_windows == [ByteWindow(1, 3)]
