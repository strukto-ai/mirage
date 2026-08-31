import pytest

from mirage.core.databricks_volume.read import read_bytes
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.ranges import ByteWindow


@pytest.mark.asyncio
async def test_read_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"hello"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))
    result = await read_bytes(accessor, path)
    assert result == b"hello"
    assert files.download_calls == [f"{remote_root}/reports/latest.md"]
    assert files.download_windows == [None]


@pytest.mark.asyncio
async def test_read_file_not_found(accessor):
    path = PathSpec.from_str_path("/volume/missing.md",
                                  mount_key("/volume/missing.md", "/volume"))
    with pytest.raises(FileNotFoundError):
        await read_bytes(accessor, path)


@pytest.mark.asyncio
async def test_read_slice(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))
    result = await read_bytes(accessor, path, offset=1, size=3)
    assert result == b"bcd"


@pytest.mark.asyncio
async def test_read_slice_asks_the_client_for_a_window(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))

    result = await read_bytes(accessor, path, offset=1, size=3)

    assert result == b"bcd"
    assert files.download_windows == [ByteWindow(1, 3)]


@pytest.mark.asyncio
async def test_read_from_offset_asks_for_an_open_ended_window(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))

    result = await read_bytes(accessor, path, offset=3)

    assert result == b"def"
    assert files.download_windows == [ByteWindow(3, None)]


@pytest.mark.asyncio
async def test_read_zero_size_returns_empty_without_network(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))

    result = await read_bytes(accessor, path, size=0)

    assert result == b""
    assert files.download_calls == []
