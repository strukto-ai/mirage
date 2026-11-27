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

import mirage.core.gdrive.read as gdrive_read
from mirage.context import session_context as caller
from mirage.core.gdrive.fingerprint import drive_fingerprint
from mirage.core.gdrive.read import read, read_file_versioned
from mirage.core.gdrive.readdir import readdir, stat_from_item
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import GoogleApiError
from mirage.observe.context import RecordingScope, recording_active
from mirage.types import FileStat, FileType, JsonValue, MountMode, PathSpec
from mirage.utils.clock import ManualClock
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import (
    FILE,
    FILES,
    MEDIA_QUERY,
    UNTIL_CLEARED,
)
from tests.fixtures.handed import entry_at

DOC = "application/vnd.google-apps.document"
SHEET = "application/vnd.google-apps.spreadsheet"
SLIDES = "application/vnd.google-apps.presentation"


def _row(
    file_id: str,
    name: str,
    resource_type: str = "gdrive/file",
    remote_time: str = "",
    extra: dict[str, JsonValue] | None = None,
) -> FileStat:
    """A row as a Drive listing names it, odd token shapes kept as given.

    Args:
        file_id (str): the Drive id.
        name (str): the row's name.
        resource_type (str): the gdrive resource type.
        remote_time (str): Drive's ``modifiedTime``.
        extra (dict[str, JsonValue] | None): further keys of the row.
    """
    extra = dict(extra or {})
    if resource_type in ("gdrive/folder", "gdrive/shared_drive"):
        return FileStat(
            name=name,
            type=FileType.DIRECTORY,
            extra={"file_id": file_id, **extra},
        )
    return FileStat(
        name=name,
        type=FileType.FILE,
        modified=remote_time,
        fingerprint=drive_fingerprint(
            resource_type,
            extra.get("md5_checksum"),
            extra.get("head_revision_id"),
            remote_time,
        ),
        extra={"file_id": file_id, "resource_type": resource_type, **extra},
    )


def _workspace(google_account, clock=None) -> Workspace:
    # A workspace binds its own clock to its mounts' clients, so retries
    # in a test that refuses one wait on the clock it is handed.
    vfs = GoogleDriveVFS(config=google_account.config(GoogleDriveConfig))
    if clock is None:
        return Workspace({"/drive/": vfs}, mode=MountMode.READ)
    return Workspace({"/drive/": vfs}, mode=MountMode.READ, clock=clock)


@pytest.mark.asyncio
async def test_read_file(google_account):
    drive = await google_account.shared_drive("Team Drive")
    content = b"pdf content here"
    await google_account.upload("report.pdf", content, drive)
    accessor = google_account.drive_accessor()
    path = PathSpec.from_str_path("/Team Drive/report.pdf")
    row = await entry_at(readdir, accessor, path)
    assert row.extra["drive_id"] == drive
    assert await read(accessor, path, entry=row) == content


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_binary_file_asks_drive_for_the_range(
    google_account,
):
    made = await google_account.upload("report.pdf", b"content")
    await google_account.run.record_requests("range")
    result = await read(
        google_account.drive_accessor(),
        PathSpec.from_str_path("/report.pdf"),
        offset=3,
        size=4,
        entry=_row(made, "report.pdf"),
    )
    assert result == b"tent"
    assert await google_account.run.headers("GET", FILE) == [
        {"range": "bytes=3-6"}
    ]


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_rendered_file_slices_what_we_rendered(
    google_account,
):
    # A google-apps file has no bytes on Drive to range over: the JSON
    # exists only once we build it, so the window comes off the result.
    made = await google_account.create("notes", DOC)
    accessor = google_account.drive_accessor()
    path = PathSpec.from_str_path("/notes.gdoc")
    entry = _row(made, "notes.gdoc", "gdrive/gdoc")
    whole = await read(accessor, path, entry=entry)
    await google_account.run.record_requests()
    result = await read(accessor, path, offset=2, size=5, entry=entry)
    assert result == whole[2:7]
    assert await google_account.log() == [
        ("GET /v1/documents/:id", f"/v1/documents/{made}")
    ]


@pytest.mark.asyncio
async def test_read_shared_drive_raises_is_a_directory(google_account):
    drive = await google_account.shared_drive("Team Drive")
    row = _row(
        drive,
        "Team Drive",
        "gdrive/shared_drive",
        extra={"drive_id": drive},
    )
    await google_account.run.record_requests()
    # The message is the bare operand, which is what the shell renders
    # ("cat: /Team Drive: Is a directory"). The TS twin asserts the same
    # string through the stamped virtualPath.
    with pytest.raises(IsADirectoryError) as excinfo:
        await read(
            google_account.drive_accessor(),
            PathSpec.from_str_path("/Team Drive"),
            entry=row,
        )
    assert excinfo.value.filename == "/Team Drive"
    assert await google_account.log() == []


@pytest.mark.asyncio
async def test_read_of_nothing_is_not_found(google_account):
    with pytest.raises(FileNotFoundError):
        await read(
            google_account.drive_accessor(),
            PathSpec.from_str_path("/missing/file.txt"),
        )


@pytest.mark.asyncio
async def test_a_cold_read_lists_its_parent_first(google_account):
    made = await google_account.upload("report.pdf", b"pdf-bytes")
    await google_account.run.record_requests()
    ws = _workspace(google_account)
    try:
        assert await ws.vfs.read("/drive/report.pdf") == b"pdf-bytes"
    finally:
        await ws.close()
    named = [name for name, _ in await google_account.log()]
    assert named[0] == "list"
    assert ("media", made) in await google_account.log()


@pytest.mark.asyncio
async def test_a_name_its_parent_does_not_list_is_never_downloaded(
    google_account,
):
    await google_account.upload("other.txt", b"other")
    await google_account.run.record_requests()
    ws = _workspace(google_account)
    try:
        with pytest.raises(FileNotFoundError):
            await ws.vfs.read("/drive/missing.txt")
    finally:
        await ws.close()
    assert "media" not in [name for name, _ in await google_account.log()]


@pytest.mark.asyncio
async def test_read_propagates_parent_listing_failure(google_account):
    await google_account.refuse(
        "GET",
        FILES,
        HTTPStatus.SERVICE_UNAVAILABLE,
        "Backend Error",
        reason="backendError",
        times=UNTIL_CLEARED,
    )
    ws = _workspace(google_account, ManualClock())
    try:
        with pytest.raises(GoogleApiError, match="Backend Error"):
            await ws.vfs.read("/drive/missing.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_recorded_read_names_the_virtual_path(google_account):
    # The record must carry the full virtual path; a slashless vfs_path
    # ("m/k.txt") names no file the cache or a snapshot pin can match.
    made = await google_account.upload("k.txt", b"bytes")
    scope = RecordingScope()
    try:
        data = await read(
            google_account.drive_accessor(),
            PathSpec(
                virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
            ),
            entry=_row(made, "k.txt"),
        )
    finally:
        scope.close()
    assert data == b"bytes"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


CONTENT = b"pdf content here"
DIGEST = hashlib.md5(CONTENT).hexdigest()
STAMP = "2026-04-01T00:00:00.000Z"
PREVIOUS = b"the previous content"
STALE = hashlib.md5(PREVIOUS).hexdigest()


def binary_row(file_id: str, revision: str) -> FileStat:
    return _row(
        file_id,
        "report.pdf",
        remote_time=STAMP,
        extra={"md5_checksum": DIGEST, "head_revision_id": revision},
    )


def spec_for(name: str = "report.pdf", prefix: str = "") -> PathSpec:
    virtual = f"{prefix}/{name}"
    return PathSpec(vfs_path=name, virtual=virtual, directory=virtual)


async def uploaded(google_account, data: bytes = CONTENT) -> tuple[str, str]:
    """Upload ``report.pdf`` holding ``data`` and return its id and head
    revision.

    Args:
        google_account (GoogleAccount): the account.
        data (bytes): the file's bytes.
    """
    made = await google_account.upload("report.pdf", data)
    return made, (await google_account.item(made))["headRevisionId"]


async def read_recording(
    google_account, path, entry, *, offset: int = 0, size=None
):
    """Read under a live recorder and hand back its records.

    Args:
        google_account (GoogleAccount): the account the file is in.
        path (PathSpec): the path to read.
        entry (FileStat): what is at the path.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    scope = RecordingScope()
    try:
        data = await read(
            google_account.drive_accessor(),
            path,
            offset=offset,
            size=size,
            entry=entry,
        )
        return data, list(scope.records)
    finally:
        scope.close()


@pytest.mark.asyncio
async def test_the_read_record_and_the_listed_stat_stamp_one_token(
    google_account,
):
    made, revision = await uploaded(google_account)
    path = spec_for()
    _, records = await read_recording(
        google_account, path, binary_row(made, revision)
    )
    result = await stat(
        google_account.drive_accessor(), path, binary_row(made, revision)
    )
    assert records[0].fingerprint == DIGEST
    assert result.fingerprint == records[0].fingerprint


@pytest.mark.asyncio
async def test_the_read_record_and_the_drive_item_stamp_one_token(
    google_account,
):
    # The row a listing builds from Drive's own item.
    made, _ = await uploaded(google_account)
    row = stat_from_item(await google_account.item(made))
    _, records = await read_recording(google_account, spec_for(), row)
    assert row.fingerprint == DIGEST
    assert row.fingerprint == records[0].fingerprint


@pytest.mark.asyncio
async def test_the_read_record_on_a_root_mount_has_one_slash(google_account):
    made, revision = await uploaded(google_account)
    _, records = await read_recording(
        google_account, spec_for(), binary_row(made, revision)
    )
    assert records[0].path == "/report.pdf"


@pytest.mark.asyncio
async def test_a_name_sharing_the_prefixs_leading_text_keeps_its_boundary(
    google_account,
):
    made, revision = await uploaded(google_account)
    _, records = await read_recording(
        google_account,
        spec_for("gd-report.pdf", "/gd"),
        binary_row(made, revision),
    )
    assert records[0].path == "/gd/gd-report.pdf"


@pytest.mark.asyncio
async def test_a_verified_md5_is_stamped_on_the_record(google_account):
    made, revision = await uploaded(google_account)
    _, records = await read_recording(
        google_account, spec_for(), binary_row(made, revision)
    )
    assert (records[0].fingerprint, records[0].revision) == (DIGEST, revision)


@pytest.mark.asyncio
async def test_a_captured_md5_that_disagrees_drops_the_revision_too(
    google_account,
):
    # Another client writes between the capture and the download: the
    # capture predates these bytes, and so does its revision, so a pin
    # would replace the drift check and replay the older bytes.
    made, revision = await uploaded(google_account, PREVIOUS)

    async def rewrite() -> None:
        await google_account.update(made, CONTENT)

    await google_account.run.before_next(
        [("GET", FILE)], rewrite, query=MEDIA_QUERY
    )
    data, records = await read_recording(
        google_account, spec_for(), binary_row(made, revision)
    )
    assert data == CONTENT
    assert (records[0].fingerprint, records[0].revision) == (None, None)


@pytest.mark.parametrize(
    "offset,size", [(1, 4), (0, 4)], ids=["ranged", "size-capped"]
)
@pytest.mark.asyncio
async def test_a_windowed_read_stamps_no_token_but_keeps_the_revision(
    google_account, offset, size
):
    made, revision = await uploaded(google_account)
    _, records = await read_recording(
        google_account,
        spec_for(),
        binary_row(made, revision),
        offset=offset,
        size=size,
    )
    assert (records[0].fingerprint, records[0].revision) == (None, revision)


@pytest.mark.asyncio
async def test_a_capture_with_no_md5_is_stamped_unverified(google_account):
    made, revision = await uploaded(google_account)
    # Drive keeps no md5 for some files; the fake keeps one for every file,
    # so its own answer to the capture is sent without it.
    captured = await google_account.item(made)
    del captured["md5Checksum"]
    await google_account.run.answer_next("GET", FILE, 200, captured)
    _, records = await read_recording(
        google_account, spec_for(), binary_row(made, revision)
    )
    assert records[0].fingerprint == revision


BODY = b"quarterly numbers\n"
BODY_MD5 = hashlib.md5(BODY).hexdigest()
UNRECORDED_STAMP = "2026-01-02T00:00:00Z"


def unrecorded_row(
    file_id: str,
    extra: dict[str, JsonValue],
    remote_time: str = UNRECORDED_STAMP,
) -> FileStat:
    return _row(file_id, "a.txt", remote_time=remote_time, extra=extra)


async def read_unrecorded(
    google_account,
    monkeypatch: pytest.MonkeyPatch,
    extra: dict[str, JsonValue],
    *,
    offset: int = 0,
    size: int | None = None,
) -> tuple[list[tuple[str, dict]], list[tuple[str, str]]]:
    # Built rather than listed: a listing drops an empty or missing md5, so
    # a listed row could not carry the odd shapes these rows need.
    made = await google_account.upload("a.txt", BODY)
    records = []

    def spy(op, path, source, nbytes, timer, **kwargs):
        records.append((path, kwargs))

    monkeypatch.setitem(vars(gdrive_read), "record", spy)
    assert not recording_active()
    await google_account.run.record_requests()
    spec = PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt")
    await read(
        google_account.drive_accessor(),
        spec,
        offset=offset,
        size=size,
        entry=unrecorded_row(made, extra),
    )
    return records, await google_account.log()


@pytest.mark.asyncio
async def test_an_unrecorded_read_stamps_the_entry_md5(
    google_account, monkeypatch
):
    records, _ = await read_unrecorded(
        google_account, monkeypatch, {"md5_checksum": BODY_MD5}
    )
    assert records == [
        ("/gd/a.txt", {"fingerprint": BODY_MD5, "revision": None})
    ]


@pytest.mark.asyncio
async def test_an_unrecorded_read_drops_a_stale_entry_md5(
    google_account, monkeypatch
):
    records, _ = await read_unrecorded(
        google_account,
        monkeypatch,
        {"md5_checksum": "0" * 32, "head_revision_id": "r7"},
    )
    assert records[0][1]["fingerprint"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_without_an_md5_stamps_the_head_revision(
    google_account, monkeypatch
):
    records, _ = await read_unrecorded(
        google_account, monkeypatch, {"head_revision_id": "r7"}
    )
    assert records[0][1]["fingerprint"] == "r7"


@pytest.mark.asyncio
async def test_an_unrecorded_read_with_neither_token_stamps_none(
    google_account, monkeypatch
):
    # A file with content never falls back to its modified stamp.
    records, _ = await read_unrecorded(google_account, monkeypatch, {})
    assert records[0][1]["fingerprint"] is None


@pytest.mark.parametrize("odd_md5", ["", 123], ids=["empty", "non-string"])
@pytest.mark.asyncio
async def test_an_unusable_entry_md5_falls_through_to_the_head_revision(
    google_account, monkeypatch, odd_md5
):
    records, _ = await read_unrecorded(
        google_account,
        monkeypatch,
        {"md5_checksum": odd_md5, "head_revision_id": "r7"},
    )
    assert records[0][1]["fingerprint"] == "r7"


@pytest.mark.asyncio
async def test_an_unrecorded_windowed_read_stamps_no_token(
    google_account, monkeypatch
):
    # No md5 on the entry, so only the window can drop the token.
    records, _ = await read_unrecorded(
        google_account, monkeypatch, {"head_revision_id": "r7"}, offset=1
    )
    assert records[0][1]["fingerprint"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_pins_no_revision(
    google_account, monkeypatch
):
    # The entry's revision can be a TTL old.
    records, _ = await read_unrecorded(
        google_account,
        monkeypatch,
        {"md5_checksum": BODY_MD5, "head_revision_id": "r7"},
    )
    assert records[0][1]["revision"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_issues_no_metadata_request(
    google_account, monkeypatch
):
    _, requests = await read_unrecorded(
        google_account, monkeypatch, {"md5_checksum": BODY_MD5}
    )
    assert [name for name, _ in requests] == ["media"]


@pytest.mark.asyncio
async def test_a_pinned_unrecorded_read_stamps_no_entry_token(
    google_account, monkeypatch
):
    # Pinned bytes are an old revision; the entry's md5 describes head.
    made = await google_account.upload("a.txt", BODY)
    pinned = (await google_account.item(made))["headRevisionId"]
    await google_account.update(made, b"newer bytes")
    records = []

    def spy(op, path, source, nbytes, timer, **kwargs):
        records.append(kwargs)

    monkeypatch.setitem(vars(gdrive_read), "record", spy)
    await google_account.run.record_requests()
    token = caller.bind_caller(
        caller.current_caller().changed({"revisions": {"/gd/a.txt": pinned}})
    )
    try:
        data = await read(
            google_account.drive_accessor(),
            PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt"),
            entry=unrecorded_row(made, {"md5_checksum": BODY_MD5}),
        )
    finally:
        caller.reset_caller(token)
    assert data == BODY
    assert records == [{"fingerprint": None, "revision": pinned}]
    assert await google_account.log() == [("revision", pinned)]


@pytest.mark.asyncio
async def test_a_recorded_read_prefers_the_capture_over_the_entry(
    google_account,
):
    # The capture is the fresher of the two; the entry can be a TTL old.
    made = await google_account.upload("a.txt", BODY)
    revision = (await google_account.item(made))["headRevisionId"]
    scope = RecordingScope()
    try:
        await read(
            google_account.drive_accessor(),
            PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt"),
            entry=unrecorded_row(made, {"md5_checksum": "0" * 32}),
        )
    finally:
        scope.close()
    assert [(r.fingerprint, r.revision) for r in scope.records] == [
        (BODY_MD5, revision)
    ]


NATIVE_READS = [
    ("gdrive/gdoc", "x.gdoc.json", DOC),
    ("gdrive/gsheet", "x.gsheet.json", SHEET),
    ("gdrive/gslide", "x.gslide.json", SLIDES),
]


async def read_native_at(
    google_account,
    mount: str,
    resource_type: str,
    vfs_name: str,
    mime: str,
    extra: dict[str, JsonValue] | None = None,
    offset: int = 0,
    size: int | None = None,
):
    made = await google_account.create("x", mime)
    virtual = f"{mount}/{vfs_name}"
    scope = RecordingScope()
    try:
        data = await read(
            google_account.drive_accessor(),
            PathSpec(
                virtual=virtual, directory=f"{mount}/", vfs_path=vfs_name
            ),
            offset=offset,
            size=size,
            entry=_row(made, vfs_name, resource_type, UNRECORDED_STAMP, extra),
        )
    finally:
        scope.close()
    return data, list(scope.records)


@pytest.mark.parametrize("resource_type,vfs_name,mime", NATIVE_READS)
@pytest.mark.parametrize("mount", ["/gd", ""], ids=["mounted", "root"])
@pytest.mark.asyncio
async def test_a_native_read_records_its_stamp_at_the_virtual_path(
    google_account, mount, resource_type, vfs_name, mime
):
    _, records = await read_native_at(
        google_account, mount, resource_type, vfs_name, mime
    )
    assert [(r.path, r.fingerprint) for r in records] == [
        (f"{mount}/{vfs_name}", UNRECORDED_STAMP)
    ]


@pytest.mark.parametrize("resource_type,vfs_name,mime", NATIVE_READS)
@pytest.mark.asyncio
async def test_a_native_read_records_no_revision(
    google_account, resource_type, vfs_name, mime
):
    # A revision pin would replace the drift check, and a render never
    # consults one.
    _, records = await read_native_at(
        google_account,
        "/gd",
        resource_type,
        vfs_name,
        mime,
        extra={"head_revision_id": "doc1-r1"},
    )
    assert records[0].revision is None


@pytest.mark.parametrize("resource_type,vfs_name,mime", NATIVE_READS)
@pytest.mark.asyncio
async def test_a_windowed_native_read_records_its_window_and_no_token(
    google_account, resource_type, vfs_name, mime
):
    data, records = await read_native_at(
        google_account,
        "/gd",
        resource_type,
        vfs_name,
        mime,
        offset=2,
        size=5,
    )
    assert len(data) == 5
    assert (records[0].bytes, records[0].fingerprint) == (5, None)


def _versioned(file_id: str) -> FileStat:
    return FileStat(
        name="f.txt",
        type=FileType.FILE,
        extra={"file_id": file_id, "resource_type": "gdrive/file"},
    )


@pytest.mark.asyncio
async def test_a_pinned_path_reads_its_revision(google_account):
    made = await google_account.upload("f.txt", b"pinned")
    pinned = (await google_account.item(made))["headRevisionId"]
    await google_account.update(made, b"live")
    await google_account.run.record_requests()
    token = caller.bind_caller(
        caller.current_caller().changed({"revisions": {"/data/f.txt": pinned}})
    )
    try:
        data = await read_file_versioned(
            google_account.drive_accessor().drive,
            made,
            "/data/f.txt",
            _versioned(made),
        )
    finally:
        caller.reset_caller(token)
    assert data == b"pinned"
    assert await google_account.log() == [("revision", pinned)]


@pytest.mark.asyncio
async def test_an_unpinned_unrecorded_path_reads_live_without_a_capture(
    google_account,
):
    made = await google_account.upload("f.txt", b"live")
    await google_account.run.record_requests()
    data = await read_file_versioned(
        google_account.drive_accessor().drive,
        made,
        "/data/f.txt",
        _versioned(made),
    )
    assert data == b"live"
    assert await google_account.log() == [("media", made)]
