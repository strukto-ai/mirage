# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import hashlib
from http import HTTPStatus

import pytest

from mirage.core.gdrive.readdir import live_row, readdir
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import GoogleApiError
from mirage.types import DirListing, FileStat, FileType, MountMode, PathSpec
from mirage.utils.clock import ManualClock
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import DRIVES, FILE, FILES, UNTIL_CLEARED
from tests.fixtures.handed import entry_at

ROOT = PathSpec(vfs_path="", virtual="/", directory="/")
DOC = "application/vnd.google-apps.document"
SHEET = "application/vnd.google-apps.spreadsheet"
SLIDES = "application/vnd.google-apps.presentation"
TIMEOUT = 0.2


def _rows(listed: list[FileStat] | DirListing) -> dict[str, FileStat]:
    rows = listed.entries if isinstance(listed, DirListing) else listed
    return {row.name: row for row in rows}


def _with(listing: dict, name: str, **fields) -> dict:
    """``listing`` with ``fields`` set on the row named ``name``, a field
    set to None taken off it.

    Args:
        listing (dict): what Drive answered for a listing.
        name (str): the row changed.
        **fields: the fields to set or, as None, to drop.
    """
    files = []
    for row in listing["files"]:
        if row["name"] == name:
            row = {k: v for k, v in (row | fields).items() if v is not None}
        files.append(row)
    return {**listing, "files": files}


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["updated", "deleted", "renamed-folder"])
async def test_a_stat_after_the_listings_drop_lists_the_ids_again(
    google_account, change
):
    old_folder = await google_account.folder("docs")
    await google_account.upload("report.pdf", b"old", old_folder)
    vfs = GoogleDriveVFS(config=google_account.config(GoogleDriveConfig))
    ws = Workspace({"/drive/": vfs}, mode=MountMode.READ)
    try:
        await ws.dispatch("readdir", PathSpec.from_str_path("/drive/docs"))
        await ws.mount("/drive/").index_store.invalidate()
        await google_account.delete(old_folder)
        name = "renamed" if change == "renamed-folder" else "docs"
        new_folder = await google_account.folder(name)
        if change != "deleted":
            new_file = await google_account.upload(
                "report.pdf", b"x" * 42, new_folder
            )
        await google_account.run.record_requests()
        path = PathSpec.from_str_path("/drive/docs/report.pdf")
        if change == "updated":
            result, _ = await ws.dispatch("stat", path)
            assert result.extra["file_id"] == new_file
            assert result.size == 42
        else:
            with pytest.raises(FileNotFoundError):
                await ws.dispatch("stat", path)
        listed = [
            detail
            for name, detail in await google_account.log()
            if name == "list"
        ]
        assert listed[0] == "root"
        assert old_folder not in listed
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_readdir_root(google_account):
    made = await google_account.upload("readme.txt", b"hi")
    rows = _rows(await readdir(google_account.drive_accessor(), ROOT))
    assert rows["readme.txt"].extra["file_id"] == made


@pytest.mark.asyncio
async def test_readdir_lists_a_folder_by_the_id_its_row_names(google_account):
    # The row names the folder "docs" but carries the id of "other": the
    # listing follows the id, never the name.
    await google_account.upload(
        "notes.txt", b"n", await google_account.folder("docs")
    )
    other = await google_account.folder("other")
    await google_account.upload("x.txt", b"x", other)
    folder = FileStat(
        name="docs", type=FileType.DIRECTORY, extra={"file_id": other}
    )
    await google_account.run.record_requests()
    rows = _rows(
        await readdir(
            google_account.drive_accessor(),
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            folder,
        )
    )
    assert await google_account.log() == [("list", other)]
    assert list(rows) == ["x.txt"]


@pytest.mark.asyncio
async def test_readdir_of_nothing_is_not_found(google_account):
    with pytest.raises(FileNotFoundError):
        await readdir(
            google_account.drive_accessor(),
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            None,
        )


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_not_a_directory(google_account):
    # Listing a file's own id answers with an empty child set rather than
    # an error, so the row has to refuse at the file itself or `/a.txt/x`
    # comes back ENOENT where opendir(2) says ENOTDIR.
    made = await google_account.upload("a.txt", b"a")
    row = FileStat(name="a.txt", type=FileType.FILE, extra={"file_id": made})
    with pytest.raises(NotADirectoryError):
        await readdir(
            google_account.drive_accessor(),
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/a.txt"),
            row,
        )


@pytest.mark.asyncio
async def test_readdir_root_includes_shared_drives(google_account):
    await google_account.upload("readme.txt", b"hi")
    drive = await google_account.shared_drive("Team Drive")
    rows = _rows(await readdir(google_account.drive_accessor(), ROOT))
    assert "readme.txt" in rows
    # Shared Drives appear as top-level directories carrying their id.
    assert rows["Team Drive"].type is FileType.DIRECTORY
    assert rows["Team Drive"].extra["drive_id"] == drive


@pytest.mark.asyncio
async def test_readdir_root_uniquifies_duplicate_shared_drive_names(
    google_account,
):
    first = await google_account.shared_drive("Team")
    second = await google_account.shared_drive("Team")
    third = await google_account.shared_drive("Team")
    rows = _rows(await readdir(google_account.drive_accessor(), ROOT))
    assert list(rows) == [
        "Team",
        "Team [Shared Drive 2]",
        "Team [Shared Drive]",
    ]
    assert rows["Team"].extra["file_id"] == first
    assert rows["Team [Shared Drive]"].extra["file_id"] == second
    assert rows["Team [Shared Drive 2]"].extra["file_id"] == third


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["forbidden", "dropped", "timeout"])
async def test_a_root_short_of_its_shared_drives_is_partial(
    google_account, failure
):
    """A short root listing must not be kept as the directory.

    Kept, it would hold the mount My-Drive-only until it expires, long
    after the cause (a missing scope) is fixed. The rows are real, so
    they are answered as a partial listing: kept as rows, not as the
    directory, and the next readdir retries enumeration.
    """
    made = await google_account.upload("readme.txt", b"hi")
    await google_account.shared_drive("Team")
    if failure == "forbidden":
        await google_account.refuse(
            "GET", DRIVES, HTTPStatus.FORBIDDEN, "Insufficient scope"
        )
    else:
        await google_account.run.answer_next(
            "GET",
            DRIVES,
            200 if failure == "timeout" else None,
            times=UNTIL_CLEARED,
            delay_ms=int(TIMEOUT * 5000) if failure == "timeout" else 0,
        )
    refused = google_account.drive_accessor(ManualClock(), timeout=TIMEOUT)
    listed = await readdir(refused, ROOT)
    assert isinstance(listed, DirListing)
    assert listed.partial
    assert _rows(listed)["readme.txt"].extra["file_id"] == made
    assert "Team" not in _rows(listed)
    await google_account.run.clear_answers()
    listed = await readdir(google_account.drive_accessor(), ROOT)
    assert not isinstance(listed, DirListing)
    assert "Team" in _rows(listed)


@pytest.mark.asyncio
async def test_a_fault_listing_the_shared_drives_is_no_short_listing(
    google_account,
):
    """Only Drive refusing or the network failing makes the root partial;
    any other fault in listing the shared drives is raised, not hidden
    behind a My-Drive-only listing.
    """
    await google_account.upload("readme.txt", b"hi")
    # A row that is no drive at all: reading it fails after the listing.
    await google_account.run.answer_next(
        "GET", DRIVES, 200, {"drives": [None]}
    )
    with pytest.raises(TypeError):
        await readdir(google_account.drive_accessor(), ROOT)


@pytest.mark.asyncio
async def test_readdir_workspace_files_get_extensions(google_account):
    await google_account.create("My Document", DOC)
    await google_account.create("My Sheet", SHEET)
    await google_account.create("My Slides", SLIDES)
    rows = _rows(await readdir(google_account.drive_accessor(), ROOT))
    assert set(rows) == {
        "My Document.gdoc.json",
        "My Sheet.gsheet.json",
        "My Slides.gslide.json",
    }


@pytest.mark.asyncio
async def test_readdir_size_binary_kept_google_apps_in_extra(google_account):
    await google_account.upload("report.pdf", b"p" * 2048)
    await google_account.create("My Document", DOC)
    # Drive counts a native file's quota in quotaBytesUsed; the fake keeps
    # no quota, so its own listing is answered with that one field added.
    await google_account.run.answer_next(
        "GET",
        FILES,
        200,
        _with(
            await google_account.listing(),
            "My Document",
            quotaBytesUsed="9999",
        ),
    )
    rows = _rows(await readdir(google_account.drive_accessor(), ROOT))
    # Binary files download raw: Drive's size is the rendered byte length.
    assert rows["report.pdf"].size == 2048
    # Google-apps files render to JSON: Drive's source size must not
    # become the row's size, it lives in extra only.
    doc = rows["My Document.gdoc.json"]
    assert doc.size is None
    assert doc.extra["source_size"] == 9999


@pytest.mark.asyncio
async def test_readdir_scoped_mount_lists_folder_children(google_account):
    scope = await google_account.folder("scope")
    await google_account.upload("in.txt", b"x", scope)
    await google_account.upload("out.txt", b"y")
    accessor = google_account.drive_accessor(folder_id=scope)
    rows = _rows(await readdir(accessor, ROOT))
    assert list(rows) == ["in.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data, reported_size, expected",
    [(b"", "0", 0), (b"x" * 42, "42", 42), (b"x" * 42, None, None)],
)
async def test_binary_size_preserves_zero_and_never_uses_quota(
    google_account, data, reported_size, expected
):
    await google_account.upload("file.txt", data)
    # Drive's quotaBytesUsed beside the size, and no size at all for the
    # last case: neither is a state the fake reaches, so its own listing
    # is answered with those fields changed.
    await google_account.run.answer_next(
        "GET",
        FILES,
        200,
        _with(
            await google_account.listing(),
            "file.txt",
            quotaBytesUsed="99",
            size=reported_size,
        ),
    )
    accessor = google_account.drive_accessor()
    rows = _rows(await readdir(accessor, PathSpec.from_str_path("/drive", "")))
    assert list(rows) == ["file.txt"]
    result = await stat(
        accessor,
        PathSpec.from_str_path("/drive/file.txt", "file.txt"),
        rows["file.txt"],
    )
    assert result.size == expected


@pytest.mark.asyncio
async def test_readdir_carries_both_content_tokens_onto_the_row(
    google_account,
):
    """A read checks its bytes against the md5 the row carries, so the
    listing has to keep it."""
    data = b"p" * 2048
    made = await google_account.upload("report.pdf", data)
    revision = (await google_account.item(made))["headRevisionId"]
    row = _rows(await readdir(google_account.drive_accessor(), ROOT))[
        "report.pdf"
    ]
    md5 = hashlib.md5(data).hexdigest()
    assert row.extra["md5_checksum"] == md5
    assert row.extra["head_revision_id"] == revision
    assert row.fingerprint == md5


@pytest.mark.asyncio
async def test_readdir_omits_the_tokens_a_native_file_does_not_have(
    google_account,
):
    """A gdoc carries neither field, and the key must be absent, not None.

    Key presence is the observable because the listing omits what Drive did
    not send. If every item carried an md5 instead, the chain's second and
    third steps would never run in any test here.
    """
    await google_account.create("My Document", DOC)
    row = _rows(await readdir(google_account.drive_accessor(), ROOT))[
        "My Document.gdoc.json"
    ]
    assert "md5_checksum" not in row.extra
    assert "head_revision_id" not in row.extra


@pytest.mark.asyncio
async def test_readdir_keeps_the_drive_beside_the_tokens(google_account):
    drive = await google_account.shared_drive("Team")
    data = b"p" * 2048
    await google_account.upload("report.pdf", data, drive)
    await google_account.create("My Document", DOC, drive)
    accessor = google_account.drive_accessor()
    path = PathSpec.from_str_path("/Team")
    folder = await entry_at(readdir, accessor, path)
    # The native file's quotaBytesUsed, which the fake keeps none of.
    await google_account.run.answer_next(
        "GET",
        FILES,
        200,
        _with(
            await google_account.listing(drive, drive),
            "My Document",
            quotaBytesUsed="9999",
        ),
    )
    rows = _rows(await readdir(accessor, path, folder))
    binary = rows["report.pdf"]
    assert binary.extra["drive_id"] == drive
    assert binary.extra["md5_checksum"] == hashlib.md5(data).hexdigest()
    native = rows["My Document.gdoc.json"]
    assert native.extra["drive_id"] == drive
    assert native.extra["source_size"] == 9999


@pytest.mark.asyncio
async def test_a_shared_drive_root_carries_no_content_token(google_account):
    """A shared drive root is a directory and has no content to fingerprint.

    The listing builds those rows at a second construction site, which
    the file-row guard cannot reach, so adding the keys there would go
    unnoticed by every other test in this file.
    """
    await google_account.shared_drive("Team Drive")
    row = _rows(await readdir(google_account.drive_accessor(), ROOT))[
        "Team Drive"
    ]
    assert "md5_checksum" not in row.extra
    assert row.fingerprint is None


@pytest.mark.asyncio
@pytest.mark.parametrize("replaced", [True, False], ids=["replaced", "gone"])
async def test_a_listed_file_deleted_since_is_looked_up_again(
    google_account, replaced
):
    """Drive answers 404 for the id a listing named once another client
    deletes the file; the folder is listed again, and what it names at
    the path now answers, None for nothing.
    """
    folder = await google_account.folder("docs")
    listed_id = await google_account.upload("a.txt", b"old", folder)
    accessor = google_account.drive_accessor()
    path = PathSpec.from_str_path("/docs/a.txt")
    listed = await entry_at(readdir, accessor, path)
    await google_account.delete(listed_id)
    made = (
        await google_account.upload("a.txt", b"new", folder)
        if replaced
        else None
    )
    row = await live_row(accessor, path, listed)
    if replaced:
        assert row is not None
        assert row.extra["file_id"] == made
    else:
        assert row is None


@pytest.mark.asyncio
async def test_a_refused_lookup_of_a_listed_file_is_raised(google_account):
    """Only Drive's 404 sends the folder to be listed again; a refusal
    reaches the caller as it is."""
    folder = await google_account.folder("docs")
    await google_account.upload("a.txt", b"a", folder)
    accessor = google_account.drive_accessor()
    path = PathSpec.from_str_path("/docs/a.txt")
    listed = await entry_at(readdir, accessor, path)
    await google_account.refuse("GET", FILE, HTTPStatus.FORBIDDEN, "Forbidden")
    with pytest.raises(GoogleApiError) as raised:
        await live_row(accessor, path, listed)
    assert raised.value.status == HTTPStatus.FORBIDDEN
    assert str(raised.value) == "Forbidden"
