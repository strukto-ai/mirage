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
from unittest.mock import AsyncMock, patch

import pytest

import mirage.core.gdrive.read as gdrive_read
from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.fingerprint import drive_fingerprint
from mirage.core.gdrive.read import read
from mirage.core.gdrive.readdir import stat_from_item
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.observe.context import (
    RecordingScope,
    active_recorder,
    push_revisions,
    reset_revisions,
)
from mirage.types import FileStat, FileType, JsonValue, MountMode, PathSpec
from mirage.utils.ranges import ByteWindow
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace


async def fail_list_files(_tm, folder_id, drive_id=None):
    raise RuntimeError("drive unavailable")


@pytest.fixture
def config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def token_manager(config):
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


@pytest.fixture
def accessor(config, token_manager):
    return GDriveAccessor(config=config, token_manager=token_manager)


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


def _workspace(accessor) -> Workspace:
    vfs = GoogleDriveVFS(
        config=GoogleDriveConfig(client_id="x", refresh_token="y")
    )
    vfs.accessor = accessor
    return Workspace({"/drive/": vfs}, mode=MountMode.READ)


@pytest.mark.asyncio
async def test_read_file(accessor):
    row = _row(
        "file123",
        "report.pdf",
        remote_time="2026-04-01T00:00:00.000Z",
        extra={"drive_id": "drive1"},
    )
    content = b"pdf content here"
    with patch(
        "mirage.core.gdrive.read.download_file",
        new_callable=AsyncMock,
        return_value=content,
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path="Team Drive/report.pdf",
                virtual="/Team Drive/report.pdf",
                directory="/Team Drive/report.pdf",
            ),
            entry=row,
        )
    assert result == content


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_binary_file_asks_drive_for_the_range(
    accessor,
):
    with patch(
        "mirage.core.gdrive.read.download_file",
        new_callable=AsyncMock,
        return_value=b"tent",
    ) as mock_download:
        result = await read(
            accessor,
            PathSpec.from_str_path("/report.pdf"),
            offset=3,
            size=4,
            entry=_row("file123", "report.pdf"),
        )
    assert result == b"tent"
    mock_download.assert_awaited_once_with(
        accessor.token_manager, "file123", ByteWindow(3, 4)
    )


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_rendered_file_slices_what_we_rendered(
    accessor,
):
    # A google-apps file has no bytes on Drive to range over: the JSON
    # exists only once we build it, so the window comes off the result.
    with patch(
        "mirage.core.gdrive.read.read_doc",
        new_callable=AsyncMock,
        return_value=b'{"title": "notes"}',
    ) as mock_doc:
        result = await read(
            accessor,
            PathSpec.from_str_path("/notes.gdoc"),
            offset=2,
            size=5,
            entry=_row("doc1", "notes.gdoc", "gdrive/gdoc"),
        )
    assert result == b"title"
    mock_doc.assert_awaited_once_with(accessor.token_manager, "doc1")


@pytest.mark.asyncio
async def test_read_shared_drive_raises_is_a_directory(accessor):
    row = _row(
        "drive1",
        "Team Drive",
        "gdrive/shared_drive",
        extra={"drive_id": "drive1"},
    )
    with patch(
        "mirage.core.gdrive.read.download_file",
        new_callable=AsyncMock,
    ) as mock_download:
        # The message is the bare operand, which is what the shell renders
        # ("cat: /Team Drive: Is a directory"). The TS twin asserts the same
        # string through the stamped virtualPath.
        with pytest.raises(IsADirectoryError) as excinfo:
            await read(
                accessor, PathSpec.from_str_path("/Team Drive"), entry=row
            )
        assert excinfo.value.filename == "/Team Drive"
    mock_download.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_of_nothing_is_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, PathSpec.from_str_path("/missing/file.txt"))


@pytest.mark.asyncio
async def test_a_cold_read_lists_its_parent_first(accessor):
    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return [
                {
                    "id": "f1",
                    "name": "report.pdf",
                    "mimeType": "application/pdf",
                    "modifiedTime": "2026-04-01T00:00:00.000Z",
                }
            ]
        raise AssertionError(f"unexpected folder_id={folder_id}")

    ws = _workspace(accessor)
    try:
        with (
            patch(
                "mirage.core.gdrive.readdir.list_files", new=fake_list_files
            ),
            patch(
                "mirage.core.gdrive.readdir.list_shared_drives",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                return_value=b"pdf-bytes",
            ),
            patch(
                "mirage.core.gdrive.read.capture_file_metadata",
                new_callable=AsyncMock,
                return_value=(None, None),
            ),
        ):
            assert await ws.vfs.read("/drive/report.pdf") == b"pdf-bytes"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_name_its_parent_does_not_list_is_never_downloaded(accessor):
    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return [
                {
                    "id": "f1",
                    "name": "other.txt",
                    "mimeType": "text/plain",
                    "modifiedTime": "2026-04-01T00:00:00.000Z",
                }
            ]
        raise AssertionError(f"unexpected folder_id={folder_id}")

    ws = _workspace(accessor)
    try:
        with (
            patch(
                "mirage.core.gdrive.readdir.list_files", new=fake_list_files
            ),
            patch(
                "mirage.core.gdrive.readdir.list_shared_drives",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                side_effect=AssertionError("should not call download_file"),
            ),
        ):
            with pytest.raises(FileNotFoundError):
                await ws.vfs.read("/drive/missing.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_read_propagates_parent_listing_failure(accessor):
    ws = _workspace(accessor)
    try:
        with patch(
            "mirage.core.gdrive.readdir.list_files", new=fail_list_files
        ):
            with pytest.raises(RuntimeError, match="drive unavailable"):
                await ws.vfs.read("/drive/missing.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_recorded_read_names_the_virtual_path(accessor):
    # The record must carry the full virtual path; a slashless vfs_path
    # ("m/k.txt") names no file the cache or a snapshot pin can match.
    scope = RecordingScope()
    try:
        with (
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                return_value=b"bytes",
            ),
            patch(
                "mirage.core.gdrive.read.capture_file_metadata",
                new_callable=AsyncMock,
                return_value=(None, "rev"),
            ),
        ):
            data = await read(
                accessor,
                PathSpec(
                    virtual="/m/m/k.txt", directory="/m/m/", vfs_path="m/k.txt"
                ),
                entry=_row("file123", "k.txt"),
            )
    finally:
        scope.close()
    assert data == b"bytes"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


CONTENT = b"pdf content here"
DIGEST = hashlib.md5(CONTENT).hexdigest()
REVISION = "file123-r1"
STAMP = "2026-04-01T00:00:00.000Z"
STALE = hashlib.md5(b"the previous content").hexdigest()


def binary_row() -> FileStat:
    return _row(
        "file123",
        "report.pdf",
        remote_time=STAMP,
        extra={"md5_checksum": DIGEST, "head_revision_id": REVISION},
    )


def spec_for(name: str = "report.pdf", prefix: str = "") -> PathSpec:
    virtual = f"{prefix}/{name}"
    return PathSpec(vfs_path=name, virtual=virtual, directory=virtual)


async def read_recording(
    accessor,
    path,
    entry,
    *,
    capture=(DIGEST, REVISION),
    offset: int = 0,
    size=None,
):
    """Read under a live recorder and hand back its records.

    The download answers the whole content whatever the window, so only
    the window guard can keep a ranged read from stamping.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): the path to read.
        entry (FileStat): what is at the path.
        capture (tuple): what ``capture_file_metadata`` answers.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    scope = RecordingScope()
    try:
        with (
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                return_value=CONTENT,
            ),
            patch(
                "mirage.core.gdrive.read.capture_file_metadata",
                new_callable=AsyncMock,
                return_value=capture,
            ),
        ):
            data = await read(
                accessor, path, offset=offset, size=size, entry=entry
            )
        return data, list(scope.records)
    finally:
        scope.close()


@pytest.mark.asyncio
async def test_the_read_record_and_the_listed_stat_stamp_one_token(accessor):
    path = spec_for()
    _, records = await read_recording(accessor, path, binary_row())
    result = await stat(accessor, path, binary_row())
    assert records[0].fingerprint == DIGEST
    assert result.fingerprint == records[0].fingerprint


@pytest.mark.asyncio
async def test_the_read_record_and_the_drive_item_stamp_one_token(
    fake_drive, gdrive_accessor
):
    # The row a listing builds from Drive's own item.
    file_id = fake_drive.add("report.pdf", content=CONTENT)
    row = stat_from_item(fake_drive.public(file_id))
    _, records = await read_recording(
        gdrive_accessor, spec_for(), row, capture=(DIGEST, f"{file_id}-r1")
    )
    assert row.fingerprint == DIGEST
    assert row.fingerprint == records[0].fingerprint


@pytest.mark.asyncio
async def test_the_read_record_on_a_root_mount_has_one_slash(accessor):
    _, records = await read_recording(accessor, spec_for(), binary_row())
    assert records[0].path == "/report.pdf"


@pytest.mark.asyncio
async def test_a_name_sharing_the_prefixs_leading_text_keeps_its_boundary(
    accessor,
):
    _, records = await read_recording(
        accessor, spec_for("gd-report.pdf", "/gd"), binary_row()
    )
    assert records[0].path == "/gd/gd-report.pdf"


@pytest.mark.asyncio
async def test_a_verified_md5_is_stamped_on_the_record(accessor):
    _, records = await read_recording(accessor, spec_for(), binary_row())
    assert (records[0].fingerprint, records[0].revision) == (DIGEST, REVISION)


@pytest.mark.asyncio
async def test_a_captured_md5_that_disagrees_drops_the_revision_too(accessor):
    # The capture predates these bytes, and so does its revision: a pin
    # would replace the drift check and replay the older bytes.
    _, records = await read_recording(
        accessor, spec_for(), binary_row(), capture=(STALE, REVISION)
    )
    assert (records[0].fingerprint, records[0].revision) == (None, None)


@pytest.mark.parametrize(
    "offset,size", [(1, 4), (0, 4)], ids=["ranged", "size-capped"]
)
@pytest.mark.asyncio
async def test_a_windowed_read_stamps_no_token_but_keeps_the_revision(
    accessor, offset, size
):
    _, records = await read_recording(
        accessor, spec_for(), binary_row(), offset=offset, size=size
    )
    assert (records[0].fingerprint, records[0].revision) == (None, REVISION)


@pytest.mark.asyncio
async def test_a_capture_with_no_md5_is_stamped_unverified(accessor):
    _, records = await read_recording(
        accessor, spec_for(), binary_row(), capture=(None, REVISION)
    )
    assert records[0].fingerprint == REVISION


BODY = b"quarterly numbers\n"
BODY_MD5 = hashlib.md5(BODY).hexdigest()
UNRECORDED_STAMP = "2026-01-02T00:00:00Z"


def unrecorded_row(
    extra: dict[str, JsonValue], remote_time: str = UNRECORDED_STAMP
) -> FileStat:
    return _row("file123", "a.txt", remote_time=remote_time, extra=extra)


async def read_unrecorded(
    accessor: GDriveAccessor,
    monkeypatch: pytest.MonkeyPatch,
    extra: dict[str, JsonValue],
    *,
    offset: int = 0,
    size: int | None = None,
) -> tuple[list[tuple[str, dict]], AsyncMock, AsyncMock]:
    # Built rather than listed: a listing drops an empty or missing md5, so
    # a listed row could not carry the odd shapes these rows need.
    records = []

    def spy(op, path, source, nbytes, timer, **kwargs):
        records.append((path, kwargs))

    monkeypatch.setitem(vars(gdrive_read), "record", spy)
    download = AsyncMock(
        return_value=BODY[offset : None if size is None else offset + size]
    )
    captured = AsyncMock(return_value=(None, None))
    monkeypatch.setitem(vars(gdrive_read), "download_file", download)
    monkeypatch.setitem(vars(gdrive_read), "capture_file_metadata", captured)
    assert active_recorder() is None
    spec = PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt")
    await read(
        accessor, spec, offset=offset, size=size, entry=unrecorded_row(extra)
    )
    return records, download, captured


@pytest.mark.asyncio
async def test_an_unrecorded_read_stamps_the_entry_md5(accessor, monkeypatch):
    records, _, _ = await read_unrecorded(
        accessor, monkeypatch, {"md5_checksum": BODY_MD5}
    )
    assert records == [
        ("/gd/a.txt", {"fingerprint": BODY_MD5, "revision": None})
    ]


@pytest.mark.asyncio
async def test_an_unrecorded_read_drops_a_stale_entry_md5(
    accessor, monkeypatch
):
    records, _, _ = await read_unrecorded(
        accessor,
        monkeypatch,
        {"md5_checksum": "0" * 32, "head_revision_id": "r7"},
    )
    assert records[0][1]["fingerprint"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_without_an_md5_stamps_the_head_revision(
    accessor, monkeypatch
):
    records, _, _ = await read_unrecorded(
        accessor, monkeypatch, {"head_revision_id": "r7"}
    )
    assert records[0][1]["fingerprint"] == "r7"


@pytest.mark.asyncio
async def test_an_unrecorded_read_with_neither_token_stamps_none(
    accessor, monkeypatch
):
    # A file with content never falls back to its modified stamp.
    records, _, _ = await read_unrecorded(accessor, monkeypatch, {})
    assert records[0][1]["fingerprint"] is None


@pytest.mark.parametrize("odd_md5", ["", 123], ids=["empty", "non-string"])
@pytest.mark.asyncio
async def test_an_unusable_entry_md5_falls_through_to_the_head_revision(
    accessor, monkeypatch, odd_md5
):
    records, _, _ = await read_unrecorded(
        accessor,
        monkeypatch,
        {"md5_checksum": odd_md5, "head_revision_id": "r7"},
    )
    assert records[0][1]["fingerprint"] == "r7"


@pytest.mark.asyncio
async def test_an_unrecorded_windowed_read_stamps_no_token(
    accessor, monkeypatch
):
    # No md5 on the entry, so only the window can drop the token.
    records, _, _ = await read_unrecorded(
        accessor, monkeypatch, {"head_revision_id": "r7"}, offset=1
    )
    assert records[0][1]["fingerprint"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_pins_no_revision(accessor, monkeypatch):
    # The entry's revision can be a TTL old.
    records, _, _ = await read_unrecorded(
        accessor,
        monkeypatch,
        {"md5_checksum": BODY_MD5, "head_revision_id": "r7"},
    )
    assert records[0][1]["revision"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_issues_no_metadata_request(
    accessor, monkeypatch
):
    _, download, captured = await read_unrecorded(
        accessor, monkeypatch, {"md5_checksum": BODY_MD5}
    )
    assert download.await_count == 1
    captured.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_pinned_unrecorded_read_stamps_no_entry_token(
    accessor, monkeypatch
):
    # Pinned bytes are an old revision; the entry's md5 describes head.
    records = []

    def spy(op, path, source, nbytes, timer, **kwargs):
        records.append(kwargs)

    monkeypatch.setitem(vars(gdrive_read), "record", spy)
    download = AsyncMock(return_value=BODY)
    revision = AsyncMock(return_value=BODY)
    monkeypatch.setitem(vars(gdrive_read), "download_file", download)
    monkeypatch.setitem(vars(gdrive_read), "download_revision", revision)
    token = push_revisions({"/gd/a.txt": "r1"})
    try:
        await read(
            accessor,
            PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt"),
            entry=unrecorded_row({"md5_checksum": BODY_MD5}),
        )
    finally:
        reset_revisions(token)
    assert records == [{"fingerprint": None, "revision": "r1"}]
    download.assert_not_awaited()
    assert revision.await_count == 1


@pytest.mark.asyncio
async def test_a_recorded_read_prefers_the_capture_over_the_entry(
    accessor, monkeypatch
):
    # The capture is the fresher of the two; the entry can be a TTL old.
    monkeypatch.setitem(
        vars(gdrive_read), "download_file", AsyncMock(return_value=BODY)
    )
    monkeypatch.setitem(
        vars(gdrive_read),
        "capture_file_metadata",
        AsyncMock(return_value=(BODY_MD5, "r9")),
    )
    scope = RecordingScope()
    try:
        await read(
            accessor,
            PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt"),
            entry=unrecorded_row({"md5_checksum": "0" * 32}),
        )
    finally:
        scope.close()
    assert [(r.fingerprint, r.revision) for r in scope.records] == [
        (BODY_MD5, "r9")
    ]


NATIVE_READS = [
    ("gdrive/gdoc", "x.gdoc.json", "read_doc"),
    ("gdrive/gsheet", "x.gsheet.json", "read_spreadsheet"),
    ("gdrive/gslide", "x.gslide.json", "read_presentation"),
]


async def read_native_at(
    accessor: GDriveAccessor,
    monkeypatch: pytest.MonkeyPatch,
    mount: str,
    resource_type: str,
    vfs_name: str,
    renderer: str,
    extra: dict[str, JsonValue] | None = None,
    offset: int = 0,
    size: int | None = None,
):
    monkeypatch.setitem(
        vars(gdrive_read), renderer, AsyncMock(return_value=b'{"tabs": []}')
    )
    virtual = f"{mount}/{vfs_name}"
    scope = RecordingScope()
    try:
        data = await read(
            accessor,
            PathSpec(
                virtual=virtual, directory=f"{mount}/", vfs_path=vfs_name
            ),
            offset=offset,
            size=size,
            entry=_row(
                "doc1", vfs_name, resource_type, UNRECORDED_STAMP, extra
            ),
        )
    finally:
        scope.close()
    return data, list(scope.records)


@pytest.mark.parametrize("resource_type,vfs_name,renderer", NATIVE_READS)
@pytest.mark.parametrize("mount", ["/gd", ""], ids=["mounted", "root"])
@pytest.mark.asyncio
async def test_a_native_read_records_its_stamp_at_the_virtual_path(
    accessor, monkeypatch, mount, resource_type, vfs_name, renderer
):
    _, records = await read_native_at(
        accessor, monkeypatch, mount, resource_type, vfs_name, renderer
    )
    assert [(r.path, r.fingerprint) for r in records] == [
        (f"{mount}/{vfs_name}", UNRECORDED_STAMP)
    ]


@pytest.mark.parametrize("resource_type,vfs_name,renderer", NATIVE_READS)
@pytest.mark.asyncio
async def test_a_native_read_records_no_revision(
    accessor, monkeypatch, resource_type, vfs_name, renderer
):
    # A revision pin would replace the drift check, and a render never
    # consults one.
    _, records = await read_native_at(
        accessor,
        monkeypatch,
        "/gd",
        resource_type,
        vfs_name,
        renderer,
        extra={"head_revision_id": "doc1-r1"},
    )
    assert records[0].revision is None


@pytest.mark.parametrize("resource_type,vfs_name,renderer", NATIVE_READS)
@pytest.mark.asyncio
async def test_a_windowed_native_read_records_its_window_and_no_token(
    accessor, monkeypatch, resource_type, vfs_name, renderer
):
    data, records = await read_native_at(
        accessor,
        monkeypatch,
        "/gd",
        resource_type,
        vfs_name,
        renderer,
        offset=2,
        size=5,
    )
    assert len(data) == 5
    assert (records[0].bytes, records[0].fingerprint) == (5, None)
