import asyncio

import pytest

from mirage.core.databricks_volume.read import read
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import ToThreadRecorder


@pytest.mark.asyncio
async def test_read_file(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"hello"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )
    result = await read(accessor, path)
    assert result == b"hello"
    assert files.download_calls == [f"{remote_root}/reports/latest.md"]


@pytest.mark.asyncio
async def test_read_file_not_found(accessor):
    path = PathSpec.from_str_path(
        "/volume/missing.md", mount_key("/volume/missing.md", "/volume")
    )
    with pytest.raises(FileNotFoundError):
        await read(accessor, path)


@pytest.mark.asyncio
async def test_read_slice(accessor, files, remote_root):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )
    result = await read(accessor, path, offset=1, size=3)
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
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )

    result = await read(accessor, path)

    assert result == b"hello"
    assert len(to_thread.calls) == 1


@pytest.mark.asyncio
async def test_read_slice_uses_databricks_range_request(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )

    result = await read(accessor, path, offset=1, size=3)

    assert result == b"bcd"
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=1-3"
    )
    assert accessor.client.api_client.do_calls[0]["raw"] is True


@pytest.mark.asyncio
async def test_read_from_offset_uses_open_ended_range(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )

    result = await read(accessor, path, offset=3)

    assert result == b"def"
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=3-"
    )


@pytest.mark.asyncio
async def test_read_zero_size_returns_empty_without_network(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )

    result = await read(accessor, path, size=0)

    assert result == b""
    assert files.download_calls == []
    assert accessor.client.api_client.do_calls == []


@pytest.mark.asyncio
async def test_a_gateway_that_ignores_the_range_is_sliced_locally(
    accessor, files, remote_root
):
    """A Range is a request, not an instruction: the Files API may sit
    behind a gateway that answers with the whole object. Before this was
    handled the caller got every byte for what it asked to be a window."""
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    accessor.client.api_client.ignore_range = True
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"),
    )

    result = await read(accessor, path, offset=1, size=3)

    assert result == b"bcd"
