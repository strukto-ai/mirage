import asyncio
from datetime import datetime, timezone

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.databricks_volume.readdir import readdir
from mirage.core.databricks_volume.stat import (_name_from_backend_path,
                                                modified_to_iso, stat)
from mirage.types import FileType, PathSpec

from .conftest import (ToThreadRecorder, directory_entry, file_entry,
                       file_metadata)


def test_modified_none_and_empty_string_return_none():
    assert modified_to_iso(None) is None
    assert modified_to_iso("") is None


def test_modified_parses_http_date_to_iso_utc():
    assert modified_to_iso(
        "Tue, 14 Nov 2023 22:13:20 GMT") == "2023-11-14T22:13:20+00:00"


def test_modified_returns_unparseable_string_verbatim():
    assert modified_to_iso("not a date") == "not a date"


def test_modified_coerces_naive_datetime_to_utc():
    naive = datetime(2023, 11, 14, 22, 13, 20)
    assert modified_to_iso(naive) == "2023-11-14T22:13:20+00:00"


def test_modified_converts_aware_datetime_to_utc():
    aware = datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    assert modified_to_iso(aware) == "2023-11-14T22:13:20+00:00"


def test_modified_treats_large_int_as_epoch_milliseconds():
    assert modified_to_iso(1_700_000_000_000) == "2023-11-14T22:13:20+00:00"


def test_name_from_backend_path_file():
    assert _name_from_backend_path(
        "/Volumes/main/default/agent_files/root/latest.md") == "latest.md"


def test_name_from_backend_path_directory_with_trailing_slash():
    assert _name_from_backend_path(
        "/Volumes/main/default/agent_files/root/reports/") == "reports"


@pytest.mark.asyncio
async def test_stat_file(accessor, files, remote_root):
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(
        size=6,
        modified="Tue, 14 Nov 2023 22:13:20 GMT",
    )
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    result = await stat(accessor, path)
    assert result.name == "latest.md"
    assert result.size == 6
    assert result.modified == "2023-11-14T22:13:20+00:00"
    assert result.type != FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_file_from_index_skips_sdk(accessor, files, index,
                                              remote_root):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md",
                   size=6,
                   modified=1_700_000_000_000),
    ]
    await readdir(accessor, PathSpec.from_str_path("/volume/reports",
                                                   "/volume"), index)
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    result = await stat(accessor, path, index)
    assert result.name == "latest.md"
    assert result.size == 6
    assert result.modified == "2023-11-14T22:13:20+00:00"
    assert result.type != FileType.DIRECTORY
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_directory_from_index_skips_sdk(accessor, files, index,
                                                   remote_root):
    files.directories[f"{remote_root}/reports"] = [
        directory_entry(f"{remote_root}/reports/archive"),
    ]
    await readdir(accessor, PathSpec.from_str_path("/volume/reports",
                                                   "/volume"), index)
    path = PathSpec.from_str_path("/volume/reports/archive", "/volume")
    result = await stat(accessor, path, index)
    assert result.name == "archive"
    assert result.type == FileType.DIRECTORY
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_index_negative_cache_raises_without_sdk(
    accessor,
    files,
    index,
    remote_root,
):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=6),
    ]
    await readdir(accessor, PathSpec.from_str_path("/volume/reports",
                                                   "/volume"), index)
    path = PathSpec.from_str_path("/volume/reports/missing.md", "/volume")
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path, index)
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_index_fast_path_matches_sdk(accessor, files, index,
                                                remote_root):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md",
                   size=6,
                   modified=1_700_000_000_000),
    ]
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(
        size=6,
        modified="Tue, 14 Nov 2023 22:13:20 GMT",
    )
    await readdir(accessor, PathSpec.from_str_path("/volume/reports",
                                                   "/volume"), index)
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    fast = await stat(accessor, path, index)
    slow = await stat(accessor, path, RAMIndexCacheStore(ttl=600))
    assert fast == slow
    assert files.get_metadata_calls == [f"{remote_root}/reports/latest.md"]


@pytest.mark.asyncio
async def test_stat_directory_index_fast_path_matches_sdk(
    accessor,
    files,
    index,
    remote_root,
):
    files.directories[f"{remote_root}/reports"] = [
        directory_entry(f"{remote_root}/reports/archive"),
    ]
    files.directory_metadata.add(f"{remote_root}/reports/archive")
    await readdir(accessor, PathSpec.from_str_path("/volume/reports",
                                                   "/volume"), index)
    path = PathSpec.from_str_path("/volume/reports/archive", "/volume")
    fast = await stat(accessor, path, index)
    slow = await stat(accessor, path, RAMIndexCacheStore(ttl=600))
    assert fast == slow
    assert files.get_directory_metadata_calls == [
        f"{remote_root}/reports/archive"
    ]


@pytest.mark.asyncio
async def test_stat_root_does_not_call_sdk(accessor, files):
    path = PathSpec.from_str_path("/volume", "/volume")
    result = await stat(accessor, path)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_directory_uses_directory_metadata_fallback(
    accessor,
    files,
    remote_root,
):
    files.directory_metadata.add(f"{remote_root}/reports")
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    result = await stat(accessor, path)
    assert result.name == "reports"
    assert result.size is None
    assert result.type == FileType.DIRECTORY
    assert files.get_metadata_calls == [f"{remote_root}/reports"]
    assert files.get_directory_metadata_calls == [f"{remote_root}/reports"]


@pytest.mark.asyncio
async def test_stat_missing_path_raises(accessor):
    path = PathSpec.from_str_path("/volume/missing", "/volume")
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path)


@pytest.mark.asyncio
async def test_stat_missing_path_checks_directory_metadata(
    accessor,
    files,
    remote_root,
):
    path = PathSpec.from_str_path("/volume/missing", "/volume")
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path)
    assert files.get_metadata_calls == [f"{remote_root}/missing"]
    assert files.get_directory_metadata_calls == [f"{remote_root}/missing"]


@pytest.mark.asyncio
async def test_stat_rejects_path_escape(accessor):
    path = PathSpec.from_str_path("/volume/../outside", "/volume")
    with pytest.raises(ValueError, match="escapes Databricks volume root"):
        await stat(accessor, path)


@pytest.mark.asyncio
async def test_stat_metadata_error_propagates(accessor, files, remote_root):
    remote_path = f"{remote_root}/reports"
    files.metadata_errors[remote_path] = RuntimeError("metadata failed")
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    with pytest.raises(RuntimeError, match="metadata failed"):
        await stat(accessor, path)
    assert files.get_metadata_calls == [remote_path]
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_directory_metadata_error_propagates(
    accessor,
    files,
    remote_root,
):
    remote_path = f"{remote_root}/reports"
    files.directory_metadata_errors[remote_path] = RuntimeError(
        "directory metadata failed")
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    with pytest.raises(RuntimeError, match="directory metadata failed"):
        await stat(accessor, path)
    assert files.get_metadata_calls == [remote_path]
    assert files.get_directory_metadata_calls == [remote_path]


@pytest.mark.asyncio
async def test_stat_runs_blocking_metadata_off_event_loop(
    accessor,
    files,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(size=6)
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await stat(accessor, path)

    assert result.name == "latest.md"
    assert len(to_thread.calls) == 1


@pytest.mark.asyncio
async def test_stat_directory_fallback_runs_off_event_loop(
    accessor,
    files,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.directory_metadata.add(f"{remote_root}/reports")
    path = PathSpec.from_str_path("/volume/reports", "/volume")

    result = await stat(accessor, path)

    assert result.type == FileType.DIRECTORY
    assert len(to_thread.calls) == 2
