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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.read import read
from mirage.core.gdrive.stat import stat
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec

CONTENT = b"pdf content here"
DIGEST = hashlib.md5(CONTENT).hexdigest()
REVISION = "file123-r1"
STAMP = "2026-04-01T00:00:00.000Z"


@pytest.fixture
def config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def accessor(config):
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=mgr)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def binary_entry() -> IndexEntry:
    return IndexEntry(
        id="file123",
        name="report",
        resource_type="gdrive/file",
        remote_time=STAMP,
        vfs_name="report.pdf",
        extra={
            "md5_checksum": DIGEST,
            "head_revision_id": REVISION,
        },
    )


def spec_for(name: str = "report.pdf", prefix: str = "") -> PathSpec:
    virtual = f"{prefix}/{name}"
    return PathSpec(vfs_path=name, virtual=virtual, directory=virtual)


async def read_recording(accessor,
                         path,
                         index,
                         *,
                         capture=(DIGEST, REVISION, STAMP),
                         download=CONTENT,
                         offset: int = 0,
                         size=None):
    """Read under a live recorder and hand back the records it collected.

    The real ``RecordingScope`` rather than a stubbed ``record``: the
    record's path is what a cache fill matches on, and a stub for
    ``record`` would skip the recorder's own handling of it.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache to read through.
        capture (tuple): what ``capture_file_metadata`` should answer.
        download (bytes): what ``download_file`` should answer.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    scope = RecordingScope()
    try:
        with patch("mirage.core.gdrive.read.download_file",
                   new_callable=AsyncMock,
                   return_value=download), \
             patch("mirage.core.gdrive.read.capture_file_metadata",
                   new_callable=AsyncMock,
                   return_value=capture):
            data = await read(accessor, path, index, offset=offset, size=size)
        return data, list(scope.records)
    finally:
        scope.close()


# --- B: the read record's token and stat's token are the same value ---


@pytest.mark.asyncio
async def test_the_read_record_and_the_index_stat_stamp_one_token(
        accessor, index):
    # The whole defect in one assertion: a `fresh` gdrive mount compares the
    # cache entry's token (stamped by the read) against stat's, so the two
    # must be the same value for the same unchanged file. The literal md5 is
    # asserted as well as the equality, because equality alone still holds
    # under a chain mutated to md5-only -- read stamps the md5 and stat reads
    # the same md5 back out of `extra` -- while every native file silently
    # loses its token.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    path = spec_for()
    _, records = await read_recording(accessor, path, index)
    result = await stat(accessor, path, index)
    assert records[0].fingerprint == DIGEST
    assert result.fingerprint == records[0].fingerprint


@pytest.mark.asyncio
async def test_the_read_record_and_the_api_stat_stamp_one_token(
        accessor, index, fake_drive, gdrive_accessor):
    # stat has two doors and the index arm is only one of them: a cold cache
    # that cannot list the parent falls through to `stat_from_api`, which
    # reads its own `get_file`. Fixing the index arm alone leaves this one
    # answering a timestamp.
    file_id = fake_drive.add("report.pdf", content=CONTENT)
    await index.set_dir('/',
                        [('report.pdf',
                          IndexEntry(id=file_id,
                                     name="report.pdf",
                                     resource_type="gdrive/file",
                                     remote_time=STAMP,
                                     vfs_name="report.pdf",
                                     extra={
                                         "md5_checksum": DIGEST,
                                         "head_revision_id": f"{file_id}-r1",
                                     }))])
    path = spec_for()
    _, records = await read_recording(gdrive_accessor,
                                      path,
                                      index,
                                      capture=(DIGEST, f"{file_id}-r1", STAMP))
    # NULL_INDEX cannot answer and cannot be warmed, so stat takes the API
    # door. The three md5s that have to agree -- the seeded entry, the fake's
    # `public()` and the capture -- are all derived from CONTENT rather than
    # hard-coded, or this fails against a correct implementation.
    api_stat = await stat(gdrive_accessor, path, NULL_INDEX)
    assert api_stat.fingerprint == DIGEST
    assert api_stat.fingerprint == records[0].fingerprint


@pytest.mark.asyncio
async def test_stat_falls_to_the_head_revision_when_there_is_no_md5(
        accessor, index):
    # Step 2 of stat's chain. Every other stat assertion here uses an
    # md5-bearing entry, so stat could be truncated to `drive_fingerprint(md5,
    # None, None)` and stay green -- which is the read/stat mismatch this
    # change removes, reintroduced on the stat side alone.
    await index.set_dir('/',
                        [('report.pdf',
                          IndexEntry(id="file123",
                                     name="report",
                                     resource_type="gdrive/file",
                                     remote_time=STAMP,
                                     vfs_name="report.pdf",
                                     extra={"head_revision_id": REVISION}))])
    result = await stat(accessor, spec_for(), index)
    assert result.fingerprint == REVISION


@pytest.mark.asyncio
async def test_stat_falls_to_the_stamp_for_a_native_file(accessor, index):
    # Step 3, and the reason the chain has three steps: a gdoc carries
    # neither content token, so the stamp is all stat can answer. Without
    # this, nothing statted a native file for its token anywhere.
    await index.set_dir('/', [('doc.gdoc.json',
                               IndexEntry(id="doc123",
                                          name="doc",
                                          resource_type="gdrive/gdoc",
                                          remote_time=STAMP,
                                          vfs_name="doc.gdoc.json",
                                          extra={}))])
    result = await stat(accessor, spec_for("doc.gdoc.json"), index)
    assert result.fingerprint == STAMP


# --- C: the record's path is the virtual path the cache is keyed by ---


@pytest.mark.asyncio
async def test_the_read_record_carries_the_virtual_path(accessor, index):
    # `latest_fingerprint` matches the record against the virtual cache key;
    # the mount path ("/report.pdf") names nothing under a mount at /gd.
    await index.set_dir('/gd', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor, spec_for(prefix="/gd"), index)
    assert records[0].path == "/gd/report.pdf"


@pytest.mark.asyncio
async def test_the_read_record_carries_the_virtual_path_on_a_root_mount(
        accessor, index):
    # On a root mount the virtual and mount paths agree, so this is the
    # control for the /gd row: only that one tells them apart.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor, spec_for(), index)
    assert records[0].path == "/report.pdf"


@pytest.mark.asyncio
async def test_a_name_sharing_the_prefixs_leading_text_keeps_its_boundary(
        accessor, index):
    # A mount at /gd holding "gd-report.pdf": the index key is derived from
    # the mount prefix, and a name sharing its leading text must still
    # resolve under /gd, or the read raises ENOENT before it records.
    entry = binary_entry()
    await index.set_dir('/gd', [('gd-report.pdf', entry)])
    _, records = await read_recording(accessor,
                                      spec_for("gd-report.pdf", "/gd"), index)
    assert records[0].path == "/gd/gd-report.pdf"


# --- D: the local md5 verification ---


@pytest.mark.asyncio
async def test_a_verified_md5_is_stamped_on_the_record(accessor, index):
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor, spec_for(), index)
    assert records[0].fingerprint == DIGEST


@pytest.mark.asyncio
async def test_a_captured_md5_that_disagrees_with_the_bytes_is_dropped(
        accessor, index):
    # The capture and the download are two separate requests, so a writer
    # that changes the file between them caches bytes B under md5(A). If the
    # file is later reverted to A, the probe reads md5(A), `is_fresh` says
    # True, and `cat` serves B while the file holds A -- silently, for the
    # life of the entry. Hashing what we actually downloaded closes it.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    stale = hashlib.md5(b"the previous content").hexdigest()
    _, records = await read_recording(accessor,
                                      spec_for(),
                                      index,
                                      capture=(stale, REVISION, STAMP))
    assert records[0].fingerprint is None


@pytest.mark.asyncio
async def test_a_ranged_read_stamps_no_token(accessor, index):
    # A whole-object token on a partial buffer reads as FRESH forever:
    # `latest_fingerprint`'s byte-identity guard only applies to writes, so
    # nothing downstream notices that the cached body is a window. The stub
    # returns the WHOLE content whatever the window, so the guard is the only
    # thing standing between this read and a stamp -- if the stub returned
    # the window the digests would disagree and this would pass either way.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor,
                                      spec_for(),
                                      index,
                                      offset=1,
                                      size=4)
    assert records[0].fingerprint is None


@pytest.mark.asyncio
async def test_a_size_capped_read_from_zero_stamps_no_token(accessor, index):
    # The guard is `offset != 0 or size is not None`, and a window at
    # offset 1 trips both halves at once -- so dropping the size half would
    # leave the other ranged test green while `head -c N`, the common shell
    # line, stamped a whole-object token on a partial body.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor,
                                      spec_for(),
                                      index,
                                      offset=0,
                                      size=4)
    assert records[0].fingerprint is None


@pytest.mark.asyncio
async def test_the_whole_file_control_for_the_ranged_read(accessor, index):
    # The positive control for the test above, on the same stub: without it
    # a stub that could never produce a stamp would make the ranged
    # assertion unfalsifiable.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor, spec_for(), index)
    assert records[0].fingerprint == DIGEST


@pytest.mark.asyncio
async def test_a_windowed_read_keeps_the_revision_it_captured(accessor, index):
    # A window proves nothing about the revision: the bytes are a slice of the
    # object the capture named, so the pin is still true even though the
    # fingerprint cannot be stamped. Dropping it here would lose snapshot
    # pinning for every ranged read.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor,
                                      spec_for(),
                                      index,
                                      offset=1,
                                      size=4)
    assert records[0].fingerprint is None
    assert records[0].revision == REVISION


@pytest.mark.asyncio
async def test_a_disagreeing_md5_drops_the_revision_as_well(accessor, index):
    # The opposite evidence, and the reason the two cases are not one branch:
    # a disagreeing md5 proves the capture predates these bytes, and the
    # revision came from that same capture. Keeping it would be worse than
    # keeping nothing -- a revision pin REPLACES the drift check, so a replay
    # would serve the pre-change bytes and report success with the mechanism
    # that would have caught it switched off.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    stale = hashlib.md5(b"the previous content").hexdigest()
    _, records = await read_recording(accessor,
                                      spec_for(),
                                      index,
                                      capture=(stale, REVISION, STAMP))
    assert records[0].fingerprint is None
    assert records[0].revision is None


@pytest.mark.asyncio
async def test_a_capture_with_no_md5_is_stamped_unverified(accessor, index):
    # Drive withholds md5Checksum for some binary files. There is nothing to
    # verify locally, so the coalesced token is stamped as-is -- dropping it
    # would leave the read at None against stat's head revision, which is
    # the very mismatch this PR exists to remove.
    await index.set_dir('/', [('report.pdf', binary_entry())])
    _, records = await read_recording(accessor,
                                      spec_for(),
                                      index,
                                      capture=(None, REVISION, STAMP))
    assert records[0].fingerprint == REVISION


# --- E: the native google-apps read record ---

NATIVE = [
    ("gdrive/gdoc", "doc.gdoc.json", "mirage.core.gdrive.read.read_doc"),
    ("gdrive/gsheet", "book.gsheet.json",
     "mirage.core.gdrive.read.read_spreadsheet"),
    ("gdrive/gslide", "deck.gslide.json",
     "mirage.core.gdrive.read.read_presentation"),
]

RENDERED = b'{"tabs": [{"title": "Tab"}]}'


def native_entry(resource_type: str,
                 vfs_name: str,
                 head_revision: str | None = None) -> IndexEntry:
    """An index entry as a listing of a native google-apps file leaves it.

    Drive gives a native file neither md5Checksum nor headRevisionId, so
    the default carries neither and the stamp is the only token -- which
    is the case the chain's third step exists for.

    Args:
        resource_type (str): the gdrive/* resource type.
        vfs_name (str): rendered file name.
        head_revision (str | None): seeded only by the revision test,
            which needs something for a wrong implementation to pass
            through, or its assertion would hold whatever the code did.
    """
    extra = {} if head_revision is None else {
        "head_revision_id": head_revision
    }
    return IndexEntry(
        id="doc123",
        name=vfs_name.rsplit(".", 2)[0],
        resource_type=resource_type,
        remote_time=STAMP,
        vfs_name=vfs_name,
        extra=extra,
    )


async def read_native(accessor,
                      index,
                      resource_type,
                      vfs_name,
                      target,
                      head_revision=None,
                      **kwargs):
    await index.set_dir(
        '/gd',
        [(vfs_name, native_entry(resource_type, vfs_name, head_revision))])
    path = spec_for(vfs_name, "/gd")
    scope = RecordingScope()
    try:
        with patch(target, new_callable=AsyncMock, return_value=RENDERED):
            data = await read(accessor, path, index, **kwargs)
        return data, list(scope.records)
    finally:
        scope.close()


@pytest.mark.parametrize("resource_type,vfs_name,target", NATIVE)
@pytest.mark.asyncio
async def test_a_native_read_records_its_token_at_the_virtual_path(
        accessor, index, resource_type, vfs_name, target):
    # Without this record a `fresh` mount re-renders every gdoc on every
    # read. The native arm makes its own record() call, so its path is
    # asserted here rather than inherited from the binary rows.
    _, records = await read_native(accessor, index, resource_type, vfs_name,
                                   target)
    assert len(records) == 1
    assert records[0].path == f"/gd/{vfs_name}"
    assert records[0].fingerprint == STAMP


@pytest.mark.parametrize("resource_type,vfs_name,target", NATIVE)
@pytest.mark.asyncio
async def test_a_native_read_records_no_revision(accessor, index,
                                                 resource_type, vfs_name,
                                                 target):
    # A revision pin REPLACES the drift check rather than supplementing it
    # (install_fingerprints continues past it), and the native branch
    # dispatches before `revision_for` is ever consulted, so a pin here is
    # dead and silently disables the check it displaced.
    _, records = await read_native(accessor,
                                   index,
                                   resource_type,
                                   vfs_name,
                                   target,
                                   head_revision="doc123-r1")
    assert records[0].revision is None


@pytest.mark.parametrize("resource_type,vfs_name,target", NATIVE)
@pytest.mark.asyncio
async def test_a_native_read_records_the_sliced_length(accessor, index,
                                                       resource_type, vfs_name,
                                                       target):
    # The binary path records the windowed download, so the native path must
    # record the window it returned and not the whole render.
    data, records = await read_native(accessor,
                                      index,
                                      resource_type,
                                      vfs_name,
                                      target,
                                      offset=2,
                                      size=5)
    assert len(data) == 5
    assert records[0].bytes == 5
    # And no token: the chain describes the whole render, so stamping it on a
    # window would cache a partial body that reads FRESH for the life of the
    # entry -- `latest_fingerprint`'s byte-identity guard is write-only, so
    # nothing downstream notices. The binary path refuses this already.
    assert records[0].fingerprint is None
