from email.utils import parsedate_to_datetime

import pytest

from mirage.core.databricks_volume.errors import DatabricksVolumeApiError
from mirage.core.databricks_volume.readdir import readdir
from mirage.core.databricks_volume.stat import (
    _name_from_backend_path,
    modified_to_iso,
    stat,
)
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import (
    DIRS,
    DIRS_PREFIX,
    FILES,
    FILES_PREFIX,
)


def test_modified_none_and_empty_string_return_none():
    assert modified_to_iso(None) is None
    assert modified_to_iso("") is None


def test_modified_parses_http_date_to_iso_utc():
    assert (
        modified_to_iso("Tue, 14 Nov 2023 22:13:20 GMT")
        == "2023-11-14T22:13:20Z"
    )


def test_modified_returns_unparseable_string_verbatim():
    assert modified_to_iso("not a date") == "not a date"


def test_modified_treats_large_int_as_epoch_milliseconds():
    assert modified_to_iso(1_700_000_000_000) == "2023-11-14T22:13:20Z"


def test_modified_treats_small_int_as_epoch_milliseconds():
    assert modified_to_iso(1000) == "1970-01-01T00:00:01Z"


def test_modified_drops_the_milliseconds_http_dates_cannot_name():
    assert modified_to_iso(1_700_000_000_750) == "2023-11-14T22:13:20Z"


def test_name_from_backend_path_file():
    assert (
        _name_from_backend_path(
            "/Volumes/main/default/agent_files/root/latest.md"
        )
        == "latest.md"
    )


def test_name_from_backend_path_directory_with_trailing_slash():
    assert (
        _name_from_backend_path(
            "/Volumes/main/default/agent_files/root/reports/"
        )
        == "reports"
    )


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual, mount_key(virtual, "/volume"))


def second_iso(http_date: str) -> str:
    """An HTTP date as the ISO time to the second a stat reports.

    Args:
        http_date (str): the ``Last-Modified`` value.
    """
    return parsedate_to_datetime(http_date).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.mark.asyncio
async def test_stat_file(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    result = await stat(accessor, spec("/volume/reports/latest.md"))
    assert result.name == "latest.md"
    assert result.size == 6
    assert result.modified == second_iso(
        await volume.modified(f"{remote_root}/reports/latest.md")
    )
    assert result.type != FileType.DIRECTORY


async def _listed(accessor, name: str):
    rows = await readdir(accessor, spec("/volume/reports"))
    return next(row for row in rows if row.name == name)


# The mount answers a stat from the row the listing names, so a row and
# the backend's own stat of the path must agree.
@pytest.mark.asyncio
async def test_a_listed_file_row_matches_its_stat(
    accessor, volume, remote_root
):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    assert await _listed(accessor, "latest.md") == await stat(
        accessor, spec("/volume/reports/latest.md")
    )


@pytest.mark.asyncio
async def test_a_listed_row_matches_its_stat_between_whole_seconds(
    accessor, volume, remote_root
):
    path = f"{remote_root}/reports/latest.md"
    await volume.put(path, b"abcdef")
    await volume.set_modified(path, 1_700_000_000_750)
    # The listing names the write to the millisecond, HEAD only to the
    # second, so a row that kept the milliseconds would differ from the
    # stat of the same file.
    listed = await volume.listing(f"{remote_root}/reports")
    assert [entry["last_modified"] for entry in listed["contents"]] == [
        1_700_000_000_750
    ]
    row = await _listed(accessor, "latest.md")
    assert row.modified == "2023-11-14T22:13:20Z"
    assert row == await stat(accessor, spec("/volume/reports/latest.md"))


@pytest.mark.asyncio
async def test_a_listed_folder_row_matches_its_stat(
    accessor, volume, remote_root
):
    await volume.mkdir(f"{remote_root}/reports/archive")
    assert await _listed(accessor, "archive") == await stat(
        accessor, spec("/volume/reports/archive")
    )


@pytest.mark.asyncio
async def test_stat_root_does_not_make_requests(accessor, volume):
    await volume.run.record_requests()
    result = await stat(accessor, spec("/volume"))
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY
    assert await volume.run.requests() == []


@pytest.mark.asyncio
async def test_stat_directory_uses_directory_metadata_fallback(
    accessor,
    volume,
    remote_root,
):
    await volume.mkdir(f"{remote_root}/reports")
    await volume.run.record_requests()
    result = await stat(accessor, spec("/volume/reports"))
    assert result.name == "reports"
    assert result.size is None
    assert result.type == FileType.DIRECTORY
    assert await volume.asked("HEAD", FILES) == [f"{remote_root}/reports"]
    assert await volume.asked("HEAD", DIRS) == [f"{remote_root}/reports"]


@pytest.mark.asyncio
async def test_stat_missing_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/volume/missing"))


@pytest.mark.asyncio
async def test_stat_missing_path_checks_directory_metadata(
    accessor,
    volume,
    remote_root,
):
    await volume.run.record_requests()
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/volume/missing"))
    assert await volume.asked("HEAD", FILES) == [f"{remote_root}/missing"]
    assert await volume.asked("HEAD", DIRS) == [f"{remote_root}/missing"]


@pytest.mark.asyncio
async def test_stat_rejects_path_escape(accessor):
    with pytest.raises(ValueError, match="escapes Databricks volume root"):
        await stat(accessor, spec("/volume/../outside"))


@pytest.mark.asyncio
async def test_stat_metadata_error_propagates(accessor, volume, remote_root):
    remote_path = f"{remote_root}/reports"
    await volume.run.answer_next(
        "HEAD", FILES, 500, path=f"{FILES_PREFIX}{remote_path}"
    )
    await volume.run.record_requests()
    with pytest.raises(DatabricksVolumeApiError, match="HTTP 500"):
        await stat(accessor, spec("/volume/reports"))
    assert await volume.asked("HEAD", FILES) == [remote_path]
    assert await volume.asked("HEAD", DIRS) == []


@pytest.mark.asyncio
async def test_stat_directory_metadata_error_propagates(
    accessor,
    volume,
    remote_root,
):
    remote_path = f"{remote_root}/reports"
    await volume.run.answer_next(
        "HEAD", DIRS, 500, path=f"{DIRS_PREFIX}{remote_path}"
    )
    await volume.run.record_requests()
    with pytest.raises(DatabricksVolumeApiError, match="HTTP 500"):
        await stat(accessor, spec("/volume/reports"))
    assert await volume.asked("HEAD", FILES) == [remote_path]
    assert await volume.asked("HEAD", DIRS) == [remote_path]
