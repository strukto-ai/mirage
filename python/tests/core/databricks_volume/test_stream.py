import pytest

from mirage.core.databricks_volume.stream import range_read, read_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


class TrackingContents:

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0
        self.read_sizes: list[int] = []
        self.closed = False

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if size < 0:
            size = len(self.data) - self.offset
        chunk = self.data[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True


class TrackingDownload:

    def __init__(self, contents: TrackingContents) -> None:
        self.contents = contents


class TrackingFiles:

    def __init__(self, contents: TrackingContents) -> None:
        self.contents = contents
        self.download_calls: list[str] = []

    def download(self, path: str) -> TrackingDownload:
        self.download_calls.append(path)
        return TrackingDownload(self.contents)


@pytest.mark.asyncio
async def test_read_stream_chunks_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))
    chunks = [
        chunk async for chunk in read_stream(accessor, path, chunk_size=2)
    ]
    assert chunks == [b"ab", b"cd", b"ef"]
    # Streaming should use one download body, not one Range GET per chunk.
    assert files.download_calls == [f"{remote_root}/reports/latest.md"]
    assert accessor.client.api_client.do_calls == []


@pytest.mark.asyncio
async def test_range_read_uses_end_exclusive(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))
    result = await range_read(accessor, path, 1, 4)
    assert result == b"bcd"


@pytest.mark.asyncio
async def test_range_read_uses_single_databricks_range_request(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))

    result = await range_read(accessor, path, 1, 4)

    assert result == b"bcd"
    assert files.download_calls == []
    assert len(accessor.client.api_client.do_calls) == 1
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=1-3")


@pytest.mark.asyncio
async def test_read_stream_reads_single_download_body_in_chunks(
    accessor,
    remote_root,
):
    contents = TrackingContents(b"abcdef")
    tracking_files = TrackingFiles(contents)
    accessor.client.files = tracking_files
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))
    stream = read_stream(accessor, path, chunk_size=2)

    first = await anext(stream)
    second = await anext(stream)

    assert first == b"ab"
    assert second == b"cd"
    assert tracking_files.download_calls == [
        f"{remote_root}/reports/latest.md"
    ]
    assert contents.read_sizes == [2, 2]
    assert not contents.closed
    await stream.aclose()
    assert contents.closed
