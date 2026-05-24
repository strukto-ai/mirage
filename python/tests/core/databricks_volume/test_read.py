import asyncio

import pytest

from mirage.core.databricks_volume.read import read_bytes
from mirage.types import PathSpec


class ToThreadRecorder:

    def __init__(self) -> None:
        self.calls = []

    async def __call__(self, fn, *args, **kwargs):
        self.calls.append((fn, args, kwargs))
        return fn(*args, **kwargs)


@pytest.mark.asyncio
async def test_read_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"hello"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    result = await read_bytes(accessor, path)
    assert result == b"hello"
    assert files.download_calls == [f"{remote_root}/reports/latest.md"]


@pytest.mark.asyncio
async def test_read_file_not_found(accessor):
    path = PathSpec.from_str_path("/volume/missing.md", "/volume")
    with pytest.raises(FileNotFoundError):
        await read_bytes(accessor, path)


@pytest.mark.asyncio
async def test_read_slice(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    result = await read_bytes(accessor, path, offset=1, size=3)
    assert result == b"bcd"


@pytest.mark.asyncio
async def test_read_file_runs_blocking_download_off_event_loop(
    accessor,
    files,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.downloads[f"{remote_root}/reports/latest.md"] = b"hello"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await read_bytes(accessor, path)

    assert result == b"hello"
    assert len(to_thread.calls) == 1


@pytest.mark.asyncio
async def test_read_slice_uses_databricks_range_request(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await read_bytes(accessor, path, offset=1, size=3)

    assert result == b"bcd"
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=1-3")
    assert accessor.client.api_client.do_calls[0]["raw"] is True


@pytest.mark.asyncio
async def test_read_from_offset_uses_open_ended_range(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await read_bytes(accessor, path, offset=3)

    assert result == b"def"
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=3-")


@pytest.mark.asyncio
async def test_read_zero_size_returns_empty_without_network(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await read_bytes(accessor, path, size=0)

    assert result == b""
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls == []
