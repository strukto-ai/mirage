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
import json
from types import SimpleNamespace

import pytest

from mirage.core.box.read import read, read_stream
from mirage.core.box.readdir import readdir
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, PathSpec
from tests.fixtures.handed import entry_at

HELLO = b"hello"
DATA = bytes(range(134))
OTHER = b"another version of the file"
ITEMS_ROUTE = "/2.0/folders/:folder_id/items"
PATH = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/a.txt")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"), virtual=virtual, directory=virtual
    )


def _sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


async def _entry(account, virtual: str = "/a.txt") -> FileStat | None:
    """What the mount's listing hands a read of ``virtual``."""
    return await entry_at(readdir, account.accessor(), _spec(virtual))


async def _listed_then_changed(account, listed: bytes, now: bytes) -> FileStat:
    """The entry a listing of ``/a.txt`` gave while it held ``listed``,
    after another client has since made it ``now``."""
    file_id = await account.put("a.txt", listed)
    entry = await _entry(account)
    if now != listed:
        await account.upload_version(file_id, now)
    return entry


async def _listed_without_sha1(account) -> FileStat:
    """``/a.txt`` as listed by a Box that gives it no sha1."""
    await account.put("a.txt", DATA)
    listing = await account.run.call("GET", "/2.0/folders/0/items")
    for row in listing["entries"]:
        row.pop("sha1", None)
    await account.run.answer_next("GET", ITEMS_ROUTE, 200, listing)
    return await _entry(account)


@pytest.mark.asyncio
async def test_read_plain_file_downloads_by_id(account):
    file_id = await account.put("a.txt", HELLO)
    entry = await _entry(account)
    await account.run.record_requests("range")
    assert await read(account.accessor(), PATH, entry=entry) == HELLO
    assert await account.run.requests() == [
        f"GET /2.0/files/{file_id}/content",
        f"GET /dl/{file_id}",
    ]


@pytest.mark.asyncio
async def test_a_ranged_read_asks_box_for_the_range(account):
    file_id = await account.put("a.txt", HELLO)
    entry = await _entry(account)
    await account.run.record_requests("range")
    got = await read(account.accessor(), PATH, offset=1, size=3, entry=entry)
    assert got == b"ell"
    assert await account.run.requests() == [
        f"GET /2.0/files/{file_id}/content range=bytes=1-3",
        f"GET /dl/{file_id} range=bytes=1-3",
    ]


@pytest.mark.asyncio
async def test_a_read_to_the_end_leaves_the_range_open(account):
    file_id = await account.put("a.txt", HELLO)
    entry = await _entry(account)
    await account.run.record_requests("range")
    got = await read(account.accessor(), PATH, offset=2, entry=entry)
    assert got == b"llo"
    assert await account.run.requests() == [
        f"GET /2.0/files/{file_id}/content range=bytes=2-",
        f"GET /dl/{file_id} range=bytes=2-",
    ]


@pytest.mark.asyncio
async def test_read_box_native_file_returns_raw_bytes(account):
    raw = json.dumps({"doc": {"content": []}}).encode()
    await account.put("n.boxnote", raw)
    out = await read(
        account.accessor(),
        _spec("/n.boxnote"),
        entry=await _entry(account, "/n.boxnote"),
    )
    assert out == raw


@pytest.mark.asyncio
async def test_read_folder_raises_eisdir(account):
    await account.mkdir("docs")
    with pytest.raises(IsADirectoryError):
        await read(
            account.accessor(),
            _spec("/docs"),
            entry=await _entry(account, "/docs"),
        )


@pytest.mark.asyncio
async def test_read_missing_populates_parent_then_raises(account):
    with pytest.raises(FileNotFoundError):
        await read(account.accessor(), _spec("/ghost.txt"), entry=None)


@pytest.mark.asyncio
async def test_stream_plain_file_chunks(account):
    await account.put("a.txt", HELLO)
    entry = await _entry(account)
    chunks = [
        c async for c in read_stream(account.accessor(), PATH, entry=entry)
    ]
    assert b"".join(chunks) == HELLO


async def _recorded_read(account, entry, **window):
    scope = RecordingScope()
    try:
        got = await read(account.accessor(), PATH, **window, entry=entry)
    finally:
        scope.close()
    return got, [(r.op, r.bytes, r.fingerprint) for r in scope.records]


@pytest.mark.asyncio
async def test_a_whole_read_stamps_the_listed_sha1(account):
    entry = await _listed_then_changed(account, DATA, DATA)
    got, records = await _recorded_read(account, entry)
    assert got == DATA
    assert records == [("read", len(DATA), _sha1(DATA))]


@pytest.mark.asyncio
async def test_a_read_of_other_bytes_than_listed_stamps_nothing(account):
    # A writer between the listing and the download: the bytes are newer
    # than the listed sha1, which must not label them.
    entry = await _listed_then_changed(account, OTHER, DATA)
    got, records = await _recorded_read(account, entry)
    assert got == DATA
    assert records == [("read", len(DATA), None)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "window, data",
    [
        ({"offset": 1}, DATA[1:]),
        ({"offset": 0, "size": 4}, DATA[:4]),
        ({"offset": 0, "size": len(DATA)}, DATA),
    ],
    ids=["tail", "head", "size-capped-whole"],
)
async def test_a_windowed_read_stamps_and_hashes_nothing(
    account, window, data, monkeypatch
):
    # A token describes the whole object; a windowed call carries none even
    # when its bytes happen to be all of them (gdrive's rule).
    entry = await _listed_then_changed(account, DATA, DATA)
    calls = _counting_sha1(monkeypatch)
    got, records = await _recorded_read(account, entry, **window)
    assert got == data
    assert records == [("read", len(data), None)]
    assert calls == []


@pytest.mark.asyncio
async def test_reads_through_a_sha1_less_entry_stamp_and_hash_nothing(
    account, monkeypatch
):
    entry = await _listed_without_sha1(account)
    calls = _counting_sha1(monkeypatch)
    got, records = await _recorded_read(account, entry)
    assert got == DATA
    assert records == [("read", len(DATA), None)]
    chunks, records = await _recorded_stream(account, entry)
    assert b"".join(chunks) == DATA
    assert records == [("read", len(DATA), None)]
    assert calls == []


async def _recorded_stream(account, entry, close_after=None):
    scope = RecordingScope()
    got: list[bytes] = []
    try:
        it = read_stream(account.accessor(), PATH, entry=entry)
        async for c in it:
            got.append(c)
            if close_after is not None and len(got) == close_after:
                await it.aclose()
                break
    finally:
        scope.close()
    assert all(
        r.complete == (close_after is None or len(got) < close_after)
        for r in scope.records
    )
    return got, [(r.op, r.bytes, r.fingerprint) for r in scope.records]


@pytest.mark.asyncio
async def test_a_drained_stream_stamps_the_listed_sha1(account):
    entry = await _listed_then_changed(account, DATA, DATA)
    got, records = await _recorded_stream(account, entry)
    assert b"".join(got) == DATA
    assert records == [("read", len(DATA), _sha1(DATA))]


@pytest.mark.asyncio
async def test_a_drained_stream_of_other_bytes_stamps_nothing(account):
    entry = await _listed_then_changed(account, OTHER, DATA)
    got, records = await _recorded_stream(account, entry)
    assert b"".join(got) == DATA
    assert records == [("read", len(DATA), None)]


@pytest.mark.asyncio
async def test_an_abandoned_stream_stamps_nothing(account):
    # One chunk, closed before the iterator ends: a stamp set up front
    # would label this read as the whole object.
    entry = await _listed_then_changed(account, DATA, DATA)
    got, records = await _recorded_stream(account, entry, close_after=1)
    assert len(got) == 1 and DATA.startswith(got[0])
    assert [fp for _, _, fp in records] == [None]


@pytest.mark.asyncio
async def test_reads_with_no_recorder_bound_still_return_bytes(
    account, monkeypatch
):
    entry = await _listed_then_changed(account, DATA, DATA)
    assert await read(account.accessor(), PATH, entry=entry) == DATA
    # Only whole reads publish a token without an observer.
    calls = _counting_sha1(monkeypatch)
    streamed = [
        c async for c in read_stream(account.accessor(), PATH, entry=entry)
    ]
    assert b"".join(streamed) == DATA
    assert calls == []


def _counting_sha1(monkeypatch) -> list[int]:
    calls: list[int] = []

    def sha1(data: bytes = b""):
        calls.append(len(data))
        return hashlib.sha1(data)

    monkeypatch.setattr(
        "mirage.core.box.read.hashlib", SimpleNamespace(sha1=sha1)
    )
    return calls


@pytest.mark.asyncio
async def test_an_empty_file_is_stamped_like_any_other(account):
    # A 0-byte file still has a sha1 (that of no bytes); falling into a
    # truthiness check would leave every fresh read of it unverifiable.
    entry = await _listed_then_changed(account, b"", b"")
    got, records = await _recorded_read(account, entry)
    assert got == b""
    assert records == [("read", 0, _sha1(b""))]
    _, records = await _recorded_stream(account, entry)
    assert records == [("read", 0, _sha1(b""))]


@pytest.mark.asyncio
async def test_a_stream_with_no_chunks_is_stamped_as_the_empty_file(account):
    # A 0-byte download yields no chunk at all; the stamp must not depend
    # on the hash having seen one.
    entry = await _listed_then_changed(account, b"", b"")
    got, records = await _recorded_stream(account, entry)
    assert got == []
    assert records == [("read", 0, _sha1(b""))]
