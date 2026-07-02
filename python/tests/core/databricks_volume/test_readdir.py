import asyncio

import pytest

from mirage.core.databricks_volume.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

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
    path = PathSpec.from_str_path("/volume/reports",
                                  mount_key("/volume/reports", "/volume"))
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
    path = PathSpec.from_str_path("/volume/reports",
                                  mount_key("/volume/reports", "/volume"))
    assert await readdir(accessor, path,
                         index) == ["/volume/reports/latest.md"]
    files.directories[f"{remote_root}/reports"] = []
    assert await readdir(accessor, path,
                         index) == ["/volume/reports/latest.md"]
    assert files.list_directory_calls == [f"{remote_root}/reports"]


@pytest.mark.asyncio
async def test_readdir_populates_index_with_size_and_modified(
    accessor,
    files,
    index,
    remote_root,
):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md",
                   size=6,
                   modified=1_700_000_000_000),
        directory_entry(f"{remote_root}/reports/archive"),
    ]
    path = PathSpec.from_str_path("/volume/reports",
                                  mount_key("/volume/reports", "/volume"))
    await readdir(accessor, path, index)
    file_lookup = await index.get("/volume/reports/latest.md")
    assert file_lookup.entry is not None
    assert file_lookup.entry.resource_type == "file"
    assert file_lookup.entry.size == 6
    assert file_lookup.entry.remote_time == "2023-11-14T22:13:20+00:00"
    dir_lookup = await index.get("/volume/reports/archive")
    assert dir_lookup.entry is not None
    assert dir_lookup.entry.resource_type == "folder"


@pytest.mark.asyncio
async def test_readdir_missing_directory_raises(accessor, index):
    path = PathSpec.from_str_path("/volume/missing",
                                  mount_key("/volume/missing", "/volume"))
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
    path = PathSpec.from_str_path("/volume/reports",
                                  mount_key("/volume/reports", "/volume"))

    result = await readdir(accessor, path, index)

    assert result == ["/volume/reports/latest.md"]
    assert len(to_thread.calls) == 1
