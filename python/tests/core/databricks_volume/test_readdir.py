from datetime import datetime, timezone

import pytest

from mirage.core.databricks_volume.readdir import readdir
from mirage.types import DirListing, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import DIRS, FILES


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual, mount_key(virtual, "/volume"))


@pytest.mark.asyncio
async def test_readdir_answers_each_child_as_its_row(
    accessor, volume, remote_root
):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    await volume.mkdir(f"{remote_root}/reports/archive")
    listed = await volume.listing(f"{remote_root}/reports")
    ms = next(
        entry["last_modified"]
        for entry in listed["contents"]
        if entry["name"] == "latest.md"
    )
    archive, latest = await readdir(accessor, spec("/volume/reports"))
    assert (archive.name, archive.type) == ("archive", FileType.DIRECTORY)
    assert (latest.name, latest.size, latest.modified) == (
        "latest.md",
        6,
        datetime.fromtimestamp(ms / 1000, timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
    )


@pytest.mark.asyncio
async def test_readdir_marks_a_listing_cut_at_a_limit_partial(
    accessor, volume, remote_root
):
    await volume.put(f"{remote_root}/reports/a.md", b"a")
    await volume.put(f"{remote_root}/reports/b.md", b"b")
    path = spec("/volume/reports")
    cut = await readdir(accessor, path, 2)
    assert isinstance(cut, DirListing) and cut.partial
    assert [row.name for row in cut.entries] == ["a.md", "b.md"]
    assert not isinstance(await readdir(accessor, path, 3), DirListing)


@pytest.mark.asyncio
async def test_readdir_backfills_lister_omitted_size(
    accessor, volume, remote_root
):
    # DirectoryEntry normally carries file_size; when the lister omits it,
    # readdir does one HEAD per affected file instead of keeping an
    # unknown size. The fake's listings leave out poem.txt's size.
    await volume.put(f"{remote_root}/reports/poem.txt", b"roses r")
    await volume.put(f"{remote_root}/reports/other.md", b"abc")
    await volume.run.record_requests()
    rows = await readdir(accessor, spec("/volume/reports"))
    assert [(row.name, row.size) for row in rows] == [
        ("other.md", 3),
        ("poem.txt", 7),
    ]
    assert await volume.asked("HEAD", FILES) == [
        f"{remote_root}/reports/poem.txt"
    ]


@pytest.mark.asyncio
async def test_readdir_missing_directory_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/volume/missing"))


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(accessor, volume, remote_root):
    # The Files API 404s `/a.txt/x` exactly as it does a name that is
    # simply absent, so only the ancestor walk can tell GNU's "Not a
    # directory" from "No such file or directory".
    await volume.put(f"{remote_root}/a.txt", b"abc")
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, spec("/volume/a.txt/x"))


@pytest.mark.asyncio
async def test_readdir_on_a_file_is_enotdir_without_walking(
    accessor, volume, remote_root
):
    # The operand is itself a file, so the shortcut in readdir_error settles
    # it: one metadata call, none for the ancestors above it.
    await volume.put(f"{remote_root}/docs/a.txt", b"abc")
    await volume.run.record_requests()
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, spec("/volume/docs/a.txt"))
    assert await volume.asked("HEAD", FILES) == [f"{remote_root}/docs/a.txt"]
    assert await volume.asked("HEAD", DIRS) == []
