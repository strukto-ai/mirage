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
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.read import read
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.observe.context import (RecordingScope, active_recorder,
                                    push_revisions, reset_revisions)
from mirage.types import JsonValue, PathSpec
from mirage.utils.ranges import ByteWindow


async def fail_list_files(_tm, folder_id, drive_id=None):
    raise RuntimeError("drive unavailable")


async def empty_list_files(_tm, folder_id, drive_id=None):
    return []


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


@pytest.fixture
def index():
    store = RAMIndexCacheStore()
    return store


@pytest.mark.asyncio
async def test_read_file(accessor, index):
    await index.set_dir('/Team Drive',
                        [('report.pdf',
                          IndexEntry(
                              id="file123",
                              name="report",
                              resource_type="gdrive/file",
                              remote_time="2026-04-01T00:00:00.000Z",
                              vfs_name="report.pdf",
                              extra={"drive_id": "drive1"},
                          ))])
    content = b"pdf content here"
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=content,
    ):
        result = await read(
            accessor,
            PathSpec(vfs_path="Team Drive/report.pdf",
                     virtual="/Team Drive/report.pdf",
                     directory="/Team Drive/report.pdf"), index)
        assert result == content


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_binary_file_asks_drive_for_the_range(
        accessor, index):
    await index.set_dir('/', [('report.pdf',
                               IndexEntry(id="file123",
                                          name="report",
                                          resource_type="gdrive/file",
                                          vfs_name="report.pdf"))])
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=b"tent",
    ) as mock_download:
        result = await read(accessor,
                            PathSpec(vfs_path="report.pdf",
                                     virtual="/report.pdf",
                                     directory="/report.pdf"),
                            index,
                            offset=3,
                            size=4)
    assert result == b"tent"
    mock_download.assert_awaited_once_with(accessor.token_manager, "file123",
                                           ByteWindow(3, 4))


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_rendered_file_slices_what_we_rendered(
        accessor, index):
    # A google-apps file has no bytes on Drive to range over: the JSON
    # exists only once we build it, so the window comes off the result.
    await index.set_dir('/', [('notes.gdoc',
                               IndexEntry(id="doc1",
                                          name="notes",
                                          resource_type="gdrive/gdoc",
                                          vfs_name="notes.gdoc"))])
    with patch(
            "mirage.core.gdrive.read.read_doc",
            new_callable=AsyncMock,
            return_value=b'{"title": "notes"}',
    ) as mock_doc:
        result = await read(accessor,
                            PathSpec(vfs_path="notes.gdoc",
                                     virtual="/notes.gdoc",
                                     directory="/notes.gdoc"),
                            index,
                            offset=2,
                            size=5)
    assert result == b"title"
    mock_doc.assert_awaited_once_with(accessor.token_manager, "doc1")


@pytest.mark.asyncio
async def test_read_shared_drive_raises_is_a_directory(accessor, index):
    await index.set_dir('/', [('Team Drive',
                               IndexEntry(
                                   id="drive1",
                                   name="Team Drive",
                                   resource_type="gdrive/shared_drive",
                                   vfs_name="Team Drive",
                                   extra={"drive_id": "drive1"},
                               ))])
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
    ) as mock_download:
        # The message is the bare operand, which is what the shell renders
        # ("cat: /Team Drive: Is a directory"). The TS twin asserts the same
        # string through the stamped virtualPath.
        with pytest.raises(IsADirectoryError) as excinfo:
            await read(
                accessor,
                PathSpec(vfs_path="Team Drive",
                         virtual="/Team Drive",
                         directory="/Team Drive"),
                index,
            )
        assert str(excinfo.value) == "/Team Drive"
    mock_download.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_not_found(accessor, index):
    with patch("mirage.core.gdrive.readdir.list_files", new=empty_list_files):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(vfs_path="missing/file.txt",
                         virtual="/missing/file.txt",
                         directory="/missing/file.txt"), index)


@pytest.mark.asyncio
async def test_read_auto_bootstraps_from_empty_index(accessor, index):

    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return [{
                "id": "f1",
                "name": "report.pdf",
                "mimeType": "application/pdf",
                "modifiedTime": "2026-04-01T00:00:00.000Z",
                "owners": [],
                "capabilities": {},
            }]
        raise AssertionError(f"unexpected folder_id={folder_id}")

    with (
            patch(
                "mirage.core.gdrive.readdir.list_files",
                new=fake_list_files,
            ),
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                return_value=b"pdf-bytes",
            ),
    ):
        result = await read(
            accessor,
            PathSpec(vfs_path="report.pdf",
                     virtual="/report.pdf",
                     directory="/report.pdf"),
            index,
        )
        assert result == b"pdf-bytes"


@pytest.mark.asyncio
async def test_read_missing_file_raises_after_recursion(accessor, index):

    async def fake_list_files(_tm, folder_id, drive_id=None):
        if folder_id == "root":
            return [{
                "id": "f1",
                "name": "other.txt",
                "mimeType": "text/plain",
                "modifiedTime": "2026-04-01T00:00:00.000Z",
                "owners": [],
                "capabilities": {},
            }]
        raise AssertionError(f"unexpected folder_id={folder_id}")

    with (
            patch(
                "mirage.core.gdrive.readdir.list_files",
                new=fake_list_files,
            ),
            patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
                side_effect=AssertionError("should not call download_file"),
            ),
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(vfs_path="missing.txt",
                         virtual="/missing.txt",
                         directory="/missing.txt"),
                index,
            )


@pytest.mark.asyncio
async def test_read_propagates_parent_refresh_failure(accessor, index):
    with patch("mirage.core.gdrive.readdir.list_files", new=fail_list_files):
        with pytest.raises(RuntimeError, match="drive unavailable"):
            await read(
                accessor,
                PathSpec(vfs_path="missing.txt",
                         virtual="/missing.txt",
                         directory="/missing.txt"),
                index,
            )


@pytest.mark.asyncio
async def test_recorded_read_names_the_virtual_path(accessor, index):
    # The record must carry the full virtual path; a slashless vfs_path
    # ("m/k.txt") names no file the cache or a snapshot pin can match.
    await index.set_dir("/m/m", [("k.txt",
                                  IndexEntry(id="file123",
                                             name="k.txt",
                                             resource_type="gdrive/file",
                                             vfs_name="k.txt"))])
    scope = RecordingScope()
    try:
        with patch("mirage.core.gdrive.read.download_file",
                   new_callable=AsyncMock,
                   return_value=b"bytes"), \
             patch("mirage.core.gdrive.read.capture_file_metadata",
                   new_callable=AsyncMock,
                   return_value=(None, "rev", None)):
            data = await read(
                accessor,
                PathSpec(virtual="/m/m/k.txt",
                         directory="/m/m/",
                         vfs_path="m/k.txt"), index)
    finally:
        scope.close()
    assert data == b"bytes"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


BODY = b"quarterly numbers\n"
BODY_MD5 = hashlib.md5(BODY).hexdigest()
UNRECORDED_STAMP = "2026-01-02T00:00:00Z"


def unrecorded_entry(extra: dict[str, JsonValue],
                     remote_time: str = UNRECORDED_STAMP) -> IndexEntry:
    return IndexEntry(id="file123",
                      name="a.txt",
                      resource_type="gdrive/file",
                      remote_time=remote_time,
                      vfs_name="a.txt",
                      extra=extra)


async def read_unrecorded(
    accessor: GDriveAccessor,
    index: RAMIndexCacheStore,
    monkeypatch: pytest.MonkeyPatch,
    extra: dict[str, JsonValue],
    *,
    remote_time: str = UNRECORDED_STAMP,
    capture: tuple[str | None, str | None, str | None] = (None, None, None),
    offset: int = 0,
    size: int | None = None,
) -> tuple[list[tuple[str, dict]], AsyncMock, AsyncMock]:
    # Seeded straight into the index rather than warmed through readdir:
    # readdir drops an empty or missing md5, so a warmed entry could not
    # carry the odd shapes these rows need.
    await index.set_dir("/gd",
                        [("a.txt", unrecorded_entry(extra, remote_time))])
    records = []

    def spy(op, path, source, nbytes, timer, **kwargs):
        records.append((path, kwargs))

    monkeypatch.setitem(vars(gdrive_read), "record", spy)
    download = AsyncMock(
        return_value=BODY[offset:None if size is None else offset + size])
    captured = AsyncMock(return_value=capture)
    monkeypatch.setitem(vars(gdrive_read), "download_file", download)
    monkeypatch.setitem(vars(gdrive_read), "capture_file_metadata", captured)
    assert active_recorder() is None
    spec = PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt")
    await read(accessor, spec, index, offset=offset, size=size)
    return records, download, captured


@pytest.mark.asyncio
async def test_an_unrecorded_read_stamps_the_entry_md5(accessor, index,
                                                       monkeypatch):
    records, _, _ = await read_unrecorded(accessor, index, monkeypatch,
                                          {"md5_checksum": BODY_MD5})
    assert records == [("/gd/a.txt", {
        "fingerprint": BODY_MD5,
        "revision": None
    })]


@pytest.mark.asyncio
async def test_an_unrecorded_read_drops_a_stale_entry_md5(
        accessor, index, monkeypatch):
    # The listing predates the download; an md5 that no longer describes the
    # bytes must not label them.
    records, _, _ = await read_unrecorded(accessor, index, monkeypatch, {
        "md5_checksum": "0" * 32,
        "head_revision_id": "r7"
    })
    assert records[0][1]["fingerprint"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_without_an_md5_stamps_the_head_revision(
        accessor, index, monkeypatch):
    records, _, _ = await read_unrecorded(accessor, index, monkeypatch,
                                          {"head_revision_id": "r7"})
    assert records[0][1]["fingerprint"] == "r7"


@pytest.mark.asyncio
async def test_an_unrecorded_read_with_neither_stamps_the_modified_time(
        accessor, index, monkeypatch):
    records, _, _ = await read_unrecorded(accessor, index, monkeypatch, {})
    assert records[0][1]["fingerprint"] == UNRECORDED_STAMP


@pytest.mark.parametrize("odd_md5", ["", 123], ids=["empty", "non-string"])
@pytest.mark.asyncio
async def test_an_unusable_entry_md5_falls_through_to_the_head_revision(
        accessor, index, monkeypatch, odd_md5):
    # An empty string is what a listing that omits the field leaves once
    # coerced, and a non-string is what a Redis-restored index can hold.
    # Neither may reach the md5 comparison and drop a usable token.
    records, _, _ = await read_unrecorded(accessor, index, monkeypatch, {
        "md5_checksum": odd_md5,
        "head_revision_id": "r7"
    })
    assert records[0][1]["fingerprint"] == "r7"


@pytest.mark.asyncio
async def test_an_unrecorded_windowed_read_stamps_no_token(
        accessor, index, monkeypatch):
    # No md5 on the entry, so the check cannot drop the token for it: only
    # the window can. The whole-file control is the head-revision row.
    records, _, _ = await read_unrecorded(accessor,
                                          index,
                                          monkeypatch,
                                          {"head_revision_id": "r7"},
                                          offset=1)
    assert records[0][1]["fingerprint"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_pins_no_revision(accessor, index,
                                                   monkeypatch):
    # The entry's revision can be a TTL old; pinning a replay to it could
    # serve bytes this read never saw.
    records, _, _ = await read_unrecorded(accessor, index, monkeypatch, {
        "md5_checksum": BODY_MD5,
        "head_revision_id": "r7"
    })
    assert records[0][1]["revision"] is None


@pytest.mark.asyncio
async def test_an_unrecorded_read_issues_no_metadata_request(
        accessor, index, monkeypatch):
    _, download, captured = await read_unrecorded(accessor, index, monkeypatch,
                                                  {"md5_checksum": BODY_MD5})
    assert download.await_count == 1
    captured.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_pinned_unrecorded_read_stamps_no_entry_token(
        accessor, index, monkeypatch):
    # Pinned bytes are an old revision; the entry's md5 describes head.
    await index.set_dir(
        "/gd", [("a.txt", unrecorded_entry({"md5_checksum": BODY_MD5}))])
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
            index)
    finally:
        reset_revisions(token)
    assert records == [{"fingerprint": None, "revision": "r1"}]
    download.assert_not_awaited()
    assert revision.await_count == 1


@pytest.mark.asyncio
async def test_a_recorded_read_prefers_the_capture_over_the_entry(
        accessor, index, monkeypatch):
    # The capture is the fresher of the two; the entry can be a TTL old.
    await index.set_dir(
        "/gd", [("a.txt", unrecorded_entry({"md5_checksum": "0" * 32}))])
    monkeypatch.setitem(vars(gdrive_read), "download_file",
                        AsyncMock(return_value=BODY))
    monkeypatch.setitem(vars(gdrive_read), "capture_file_metadata",
                        AsyncMock(return_value=(BODY_MD5, "r9", None)))
    scope = RecordingScope()
    try:
        await read(
            accessor,
            PathSpec(virtual="/gd/a.txt", directory="/gd/", vfs_path="a.txt"),
            index)
    finally:
        scope.close()
    assert [(r.fingerprint, r.revision)
            for r in scope.records] == [(BODY_MD5, "r9")]


NATIVE_READS = [
    ("gdrive/gdoc", "x.gdoc.json", "read_doc"),
    ("gdrive/gsheet", "x.gsheet.json", "read_spreadsheet"),
    ("gdrive/gslide", "x.gslide.json", "read_presentation"),
]


async def read_native_at(accessor: GDriveAccessor, index: RAMIndexCacheStore,
                         monkeypatch: pytest.MonkeyPatch, mount: str,
                         resource_type: str, vfs_name: str,
                         renderer: str) -> list[str]:
    await index.set_dir(mount or "/",
                        [(vfs_name,
                          IndexEntry(id="doc1",
                                     name="x",
                                     resource_type=resource_type,
                                     remote_time=UNRECORDED_STAMP,
                                     vfs_name=vfs_name))])
    monkeypatch.setitem(vars(gdrive_read), renderer,
                        AsyncMock(return_value=b"{}"))
    virtual = f"{mount}/{vfs_name}"
    scope = RecordingScope()
    try:
        await read(
            accessor,
            PathSpec(virtual=virtual, directory=f"{mount}/",
                     vfs_path=vfs_name), index)
    finally:
        scope.close()
    return [r.path for r in scope.records]


@pytest.mark.parametrize("resource_type,vfs_name,renderer", NATIVE_READS)
@pytest.mark.asyncio
async def test_a_native_read_records_the_virtual_path(accessor, index,
                                                      monkeypatch,
                                                      resource_type, vfs_name,
                                                      renderer):
    # The cache fill matches the record on the virtual path; the mount path
    # ("/x.gdoc.json") names nothing under a mount at /gd.
    paths = await read_native_at(accessor, index, monkeypatch, "/gd",
                                 resource_type, vfs_name, renderer)
    assert paths == [f"/gd/{vfs_name}"]


@pytest.mark.parametrize("resource_type,vfs_name,renderer", NATIVE_READS)
@pytest.mark.asyncio
async def test_a_native_read_on_a_root_mount_records_one_slash(
        accessor, index, monkeypatch, resource_type, vfs_name, renderer):
    paths = await read_native_at(accessor, index, monkeypatch, "",
                                 resource_type, vfs_name, renderer)
    assert paths == [f"/{vfs_name}"]
