import asyncio

import pytest

from mirage.core.databricks_volume.readdir import readdir
from mirage.types import PathSpec

from .conftest import ToThreadRecorder, directory_entry, file_entry


@pytest.mark.asyncio
async def test_readdir_returns_full_virtual_paths(
    accessor,
    files,
    index,
    remote_root,
):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=6),
        directory_entry(f"{remote_root}/reports/archive"),
    ]
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    result = await readdir(accessor, path, index)
    assert result == [
        "/volume/reports/archive",
        "/volume/reports/latest.md",
    ]


@pytest.mark.asyncio
async def test_readdir_uses_cached_listing(accessor, files, index,
                                           remote_root):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=6),
    ]
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    assert await readdir(accessor, path,
                         index) == ["/volume/reports/latest.md"]
    files.directories[f"{remote_root}/reports"] = []
    assert await readdir(accessor, path,
                         index) == ["/volume/reports/latest.md"]
    assert files.list_directory_calls == [f"{remote_root}/reports"]


@pytest.mark.asyncio
async def test_readdir_missing_directory_raises(accessor, index):
    path = PathSpec.from_str_path("/volume/missing", "/volume")
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, path, index)


@pytest.mark.asyncio
async def test_readdir_runs_blocking_list_off_event_loop(
    accessor,
    files,
    index,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=6),
    ]
    path = PathSpec.from_str_path("/volume/reports", "/volume")

    result = await readdir(accessor, path, index)

    assert result == ["/volume/reports/latest.md"]
    assert len(to_thread.calls) == 1
