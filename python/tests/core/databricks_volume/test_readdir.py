import asyncio

import pytest

from mirage.core.databricks_volume.readdir import readdir
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import (
    ToThreadRecorder,
    directory_entry,
    file_entry,
    file_metadata,
)


@pytest.mark.asyncio
async def test_readdir_answers_each_child_as_its_row(
    accessor, files, remote_root
):
    files.directories[f"{remote_root}/reports"] = [
        file_entry(
            f"{remote_root}/reports/latest.md",
            size=6,
            modified=1_700_000_000_000,
        ),
        directory_entry(f"{remote_root}/reports/archive"),
    ]
    path = PathSpec.from_str_path(
        "/volume/reports", mount_key("/volume/reports", "/volume")
    )
    archive, latest = await readdir(accessor, path)
    assert (archive.name, archive.type) == ("archive", FileType.DIRECTORY)
    assert (latest.name, latest.size, latest.modified) == (
        "latest.md",
        6,
        "2023-11-14T22:13:20Z",
    )


@pytest.mark.asyncio
async def test_readdir_backfills_lister_omitted_size(
    accessor, files, remote_root
):
    # DirectoryEntry normally carries file_size; when the lister omits it,
    # readdir does one HEAD per affected file instead of keeping an
    # unknown size.
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=None),
        file_entry(f"{remote_root}/reports/other.md", size=3),
    ]
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(7)
    path = PathSpec.from_str_path(
        "/volume/reports", mount_key("/volume/reports", "/volume")
    )
    rows = await readdir(accessor, path)
    assert [(row.name, row.size) for row in rows] == [
        ("latest.md", 7),
        ("other.md", 3),
    ]
    assert files.get_metadata_calls == [f"{remote_root}/reports/latest.md"]


@pytest.mark.asyncio
async def test_readdir_missing_directory_raises(accessor):
    path = PathSpec.from_str_path(
        "/volume/missing", mount_key("/volume/missing", "/volume")
    )
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, path)


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(accessor, files, remote_root):
    # The Files API 404s `/a.txt/x` exactly as it does a name that is
    # simply absent, so only the ancestor walk can tell GNU's "Not a
    # directory" from "No such file or directory".
    files.directory_metadata.add(remote_root)
    files.metadata[f"{remote_root}/a.txt"] = file_metadata(3)
    path = PathSpec.from_str_path(
        "/volume/a.txt/x", mount_key("/volume/a.txt/x", "/volume")
    )
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, path)


@pytest.mark.asyncio
async def test_readdir_on_a_file_is_enotdir_without_walking(
    accessor, files, remote_root
):
    # The operand is itself a file, so the shortcut in readdir_error settles
    # it: one metadata call, none for the ancestors above it.
    files.directory_metadata.add(f"{remote_root}/docs")
    files.metadata[f"{remote_root}/docs/a.txt"] = file_metadata(3)
    path = PathSpec.from_str_path(
        "/volume/docs/a.txt", mount_key("/volume/docs/a.txt", "/volume")
    )
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, path)
    assert files.get_metadata_calls == [f"{remote_root}/docs/a.txt"]
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_readdir_runs_blocking_list_off_event_loop(
    accessor,
    files,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=6),
    ]
    path = PathSpec.from_str_path(
        "/volume/reports", mount_key("/volume/reports", "/volume")
    )

    result = await readdir(accessor, path)

    assert [row.name for row in result] == ["latest.md"]
    assert len(to_thread.calls) == 1
