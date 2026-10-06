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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.config import IndexEntry
from mirage.core.box.read import read, read_stream
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.ranges import ByteWindow


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"), virtual=virtual, directory=virtual
    )


@pytest.mark.asyncio
async def test_read_plain_file_downloads_by_id(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    vfs_name="a.txt",
                ),
            )
        ],
    )
    with patch(
        "mirage.core.box.read.download_file",
        new_callable=AsyncMock,
        return_value=b"hello",
    ) as mock_dl:
        assert await read(accessor, _spec("/a.txt"), index) == b"hello"
    mock_dl.assert_awaited_once_with(accessor.token_manager, "200", None)


@pytest.mark.asyncio
async def test_a_ranged_read_asks_box_for_the_range(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    vfs_name="a.txt",
                ),
            )
        ],
    )
    with patch(
        "mirage.core.box.read.download_file",
        new_callable=AsyncMock,
        return_value=b"ell",
    ) as mock_dl:
        got = await read(accessor, _spec("/a.txt"), index, offset=1, size=3)
    assert got == b"ell"
    mock_dl.assert_awaited_once_with(
        accessor.token_manager, "200", ByteWindow(1, 3)
    )


@pytest.mark.asyncio
async def test_a_read_to_the_end_leaves_the_range_open(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    vfs_name="a.txt",
                ),
            )
        ],
    )
    with patch(
        "mirage.core.box.read.download_file",
        new_callable=AsyncMock,
        return_value=b"llo",
    ) as mock_dl:
        assert await read(accessor, _spec("/a.txt"), index, offset=2) == b"llo"
    mock_dl.assert_awaited_once_with(
        accessor.token_manager, "200", ByteWindow(2, None)
    )


@pytest.mark.asyncio
async def test_read_box_native_file_returns_raw_bytes(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "n.boxnote",
                IndexEntry(
                    id="300",
                    name="n.boxnote",
                    resource_type="box/file",
                    vfs_name="n.boxnote",
                ),
            )
        ],
    )
    raw = json.dumps({"doc": {"content": []}}).encode()
    with patch(
        "mirage.core.box.read.download_file",
        new_callable=AsyncMock,
        return_value=raw,
    ):
        out = await read(accessor, _spec("/n.boxnote"), index)
    assert out == raw


@pytest.mark.asyncio
async def test_read_folder_raises_eisdir(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "docs",
                IndexEntry(
                    id="100",
                    name="docs",
                    resource_type="box/folder",
                    vfs_name="docs",
                ),
            )
        ],
    )
    with pytest.raises(IsADirectoryError):
        await read(accessor, _spec("/docs"), index)


@pytest.mark.asyncio
async def test_read_missing_populates_parent_then_raises(accessor, index):
    with patch(
        "mirage.core.box.readdir.list_folder_items",
        new_callable=AsyncMock,
        return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _spec("/ghost.txt"), index)


@pytest.mark.asyncio
async def test_stream_plain_file_chunks(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    vfs_name="a.txt",
                ),
            )
        ],
    )

    async def fake_stream(_tm, _fid):
        yield b"he"
        yield b"llo"

    with patch("mirage.core.box.read.download_file_stream", new=fake_stream):
        chunks = [
            c async for c in read_stream(accessor, _spec("/a.txt"), index)
        ]
    assert b"".join(chunks) == b"hello"


DATA = bytes(range(134))
OTHER = b"another version of the file"


async def _listed(index, sha1):
    extra = {} if sha1 is None else {"sha1": sha1}
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    vfs_name="a.txt",
                    extra=extra,
                ),
            )
        ],
    )


async def _recorded_read(accessor, index, data, **window):
    scope = RecordingScope()
    try:
        with patch(
            "mirage.core.box.read.download_file",
            new_callable=AsyncMock,
            return_value=data,
        ):
            got = await read(accessor, _spec("/a.txt"), index, **window)
    finally:
        scope.close()
    return got, [(r.op, r.bytes, r.fingerprint) for r in scope.records]


def _sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


@pytest.mark.asyncio
async def test_a_whole_read_stamps_the_listed_sha1(accessor, index):
    await _listed(index, _sha1(DATA))
    got, records = await _recorded_read(accessor, index, DATA)
    assert got == DATA
    assert records == [("read", len(DATA), _sha1(DATA))]


@pytest.mark.asyncio
async def test_a_read_of_other_bytes_than_listed_stamps_nothing(
    accessor, index
):
    # A writer between the listing and the download: the bytes are newer
    # than the listed sha1, which must not label them.
    await _listed(index, _sha1(OTHER))
    got, records = await _recorded_read(accessor, index, DATA)
    assert got == DATA
    assert records == [("read", len(DATA), None)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "window, data",
    [
        ({"offset": 1}, DATA[1:]),
        ({"offset": 0, "size": 4}, DATA[:4]),
        ({"offset": 0, "size": len(DATA)}, DATA),
        ({"offset": 1}, DATA),
    ],
    ids=["tail", "head", "size-capped-whole", "range-ignored"],
)
async def test_a_windowed_read_stamps_and_hashes_nothing(
    accessor, index, window, data, monkeypatch
):
    # A token describes the whole object; a windowed call carries none even
    # when its bytes happen to be all of them (gdrive's rule).
    await _listed(index, _sha1(DATA))
    calls = _counting_sha1(monkeypatch)
    got, records = await _recorded_read(accessor, index, data, **window)
    assert got == data
    assert records == [("read", len(data), None)]
    assert calls == []


@pytest.mark.asyncio
async def test_reads_through_a_sha1_less_entry_stamp_and_hash_nothing(
    accessor, index, monkeypatch
):
    await _listed(index, None)
    calls = _counting_sha1(monkeypatch)
    got, records = await _recorded_read(accessor, index, DATA)
    assert got == DATA
    assert records == [("read", len(DATA), None)]
    chunks, records = await _recorded_stream(
        accessor, index, DATA[:64], DATA[64:]
    )
    assert b"".join(chunks) == DATA
    assert records == [("read", len(DATA), None)]
    assert calls == []


def _chunked(*chunks: bytes):
    async def fake_stream(_tm, _fid):
        for c in chunks:
            yield c

    return fake_stream


async def _recorded_stream(accessor, index, *chunks, close_after=None):
    scope = RecordingScope()
    got: list[bytes] = []
    try:
        with patch(
            "mirage.core.box.read.download_file_stream", new=_chunked(*chunks)
        ):
            it = read_stream(accessor, _spec("/a.txt"), index)
            async for c in it:
                got.append(c)
                if close_after is not None and len(got) == close_after:
                    await it.aclose()
                    break
    finally:
        scope.close()
    return got, [(r.op, r.bytes, r.fingerprint) for r in scope.records]


@pytest.mark.asyncio
async def test_a_drained_stream_stamps_the_listed_sha1(accessor, index):
    await _listed(index, _sha1(DATA))
    chunks = (DATA[:1], DATA[1:64], DATA[64:])
    got, records = await _recorded_stream(accessor, index, *chunks)
    assert b"".join(got) == DATA
    assert records == [("read", len(DATA), _sha1(DATA))]


@pytest.mark.asyncio
async def test_a_drained_stream_of_other_bytes_stamps_nothing(accessor, index):
    await _listed(index, _sha1(OTHER))
    got, records = await _recorded_stream(
        accessor, index, DATA[:64], DATA[64:]
    )
    assert records == [("read", len(DATA), None)]


@pytest.mark.asyncio
async def test_an_abandoned_stream_stamps_nothing(accessor, index):
    # One chunk, closed before the iterator ends: a stamp set up front
    # would label this read as the whole object.
    await _listed(index, _sha1(DATA))
    got, records = await _recorded_stream(accessor, index, DATA, close_after=1)
    assert got == [DATA]
    assert [fp for _, _, fp in records] == [None]


@pytest.mark.asyncio
async def test_reads_with_no_recorder_bound_still_return_bytes(
    accessor, index, monkeypatch
):
    await _listed(index, _sha1(DATA))
    with patch(
        "mirage.core.box.read.download_file",
        new_callable=AsyncMock,
        return_value=DATA,
    ):
        assert await read(accessor, _spec("/a.txt"), index) == DATA
    # Only whole reads publish a token without an observer.
    calls = _counting_sha1(monkeypatch)
    with patch(
        "mirage.core.box.read.download_file_stream", new=_chunked(DATA)
    ):
        assert [
            c async for c in read_stream(accessor, _spec("/a.txt"), index)
        ] == [DATA]
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
async def test_an_empty_file_is_stamped_like_any_other(accessor, index):
    # A 0-byte file still has a sha1 (that of no bytes); falling into a
    # truthiness check would leave every fresh read of it unverifiable.
    await _listed(index, _sha1(b""))
    got, records = await _recorded_read(accessor, index, b"")
    assert got == b""
    assert records == [("read", 0, _sha1(b""))]
    _, records = await _recorded_stream(accessor, index, b"")
    assert records == [("read", 0, _sha1(b""))]


@pytest.mark.asyncio
async def test_a_stream_with_no_chunks_is_stamped_as_the_empty_file(
    accessor, index
):
    # A 0-byte download may yield no chunk at all; the stamp must not depend
    # on the hash having seen one.
    await _listed(index, _sha1(b""))
    got, records = await _recorded_stream(accessor, index)
    assert got == []
    assert records == [("read", 0, _sha1(b""))]
