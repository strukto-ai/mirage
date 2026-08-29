import pytest

from mirage.core.databricks_volume.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

from ._fakes import directory_entry, file_entry, file_metadata


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
async def test_readdir_backfills_lister_omitted_size(
    accessor,
    files,
    index,
    remote_root,
):
    # DirectoryEntry normally carries file_size; when the lister omits it,
    # readdir does one HEAD per affected file instead of caching an
    # unknown size.
    files.directories[f"{remote_root}/reports"] = [
        file_entry(f"{remote_root}/reports/latest.md", size=None),
        file_entry(f"{remote_root}/reports/other.md", size=3),
    ]
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(7)
    path = PathSpec.from_str_path("/volume/reports",
                                  mount_key("/volume/reports", "/volume"))
    await readdir(accessor, path, index)
    lookup = await index.get("/volume/reports/latest.md")
    assert lookup.entry is not None
    assert lookup.entry.size == 7
    assert files.get_metadata_calls == [f"{remote_root}/reports/latest.md"]


@pytest.mark.asyncio
async def test_readdir_missing_directory_raises(accessor, index):
    path = PathSpec.from_str_path("/volume/missing",
                                  mount_key("/volume/missing", "/volume"))
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, path, index)


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(accessor, files, index,
                                               remote_root):
    # The Files API 404s `/a.txt/x` exactly as it does a name that is
    # simply absent, so only the ancestor walk can tell GNU's "Not a
    # directory" from "No such file or directory".
    files.directory_metadata.add(remote_root)
    files.metadata[f"{remote_root}/a.txt"] = file_metadata(3)
    path = PathSpec.from_str_path("/volume/a.txt/x",
                                  mount_key("/volume/a.txt/x", "/volume"))
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, path, index)


@pytest.mark.asyncio
async def test_readdir_on_a_file_is_enotdir_without_walking(
        accessor, files, index, remote_root):
    # The operand is itself a file, so the shortcut in readdir_error settles
    # it: one metadata call, none for the ancestors above it.
    files.directory_metadata.add(f"{remote_root}/docs")
    files.metadata[f"{remote_root}/docs/a.txt"] = file_metadata(3)
    path = PathSpec.from_str_path("/volume/docs/a.txt",
                                  mount_key("/volume/docs/a.txt", "/volume"))
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, path, index)
    assert files.get_metadata_calls == [f"{remote_root}/docs/a.txt"]
    assert files.get_directory_metadata_calls == []
