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
from unittest.mock import AsyncMock, Mock

import pytest

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.types import WriteCondition
from mirage.core.gridfs import driver as gridfs_driver
from mirage.core.gridfs.read import read
from mirage.core.gridfs.unlink import unlink
from mirage.core.gridfs.write import write
from mirage.types import PathSpec
from mirage.vfs.gridfs.config import GridFSConfig
from tests.fixtures.gridfs_store import FakeStore, make_accessor

A_TXT = PathSpec(vfs_path="a.txt", virtual="/mnt/a.txt", directory="/mnt")


@pytest.mark.asyncio
async def test_write_reports_the_new_revision_as_the_object_token(
    store: FakeStore,
):
    """gridfs spells a token as the uploaded revision's _id, the same
    string ``_head`` answers for the latest revision."""
    meta = await gridfs_driver.DRIVER.put(make_accessor(), "a/b.txt", b"hi")
    assert meta is not None
    (oid,) = store.ids("a/b.txt")
    assert meta.fingerprint == meta.revision == str(oid)
    assert meta.size == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_stream_upload_commits_or_aborts_and_closes_source(
    monkeypatch, fail
):
    upload = Mock(
        _id="new-id", write=AsyncMock(), close=AsyncMock(), abort=AsyncMock()
    )
    monkeypatch.setattr(
        gridfs_driver,
        "bucket",
        lambda _: Mock(open_upload_stream=Mock(return_value=upload)),
    )
    closed = []

    async def source():
        try:
            yield b"first"
            if fail:
                raise RuntimeError("producer failed")
            yield b"last"
        finally:
            closed.append(True)

    accessor = GridFSAccessor(
        GridFSConfig(uri="mongodb://localhost:27017", database="db")
    )
    if fail:
        with pytest.raises(RuntimeError, match="producer failed"):
            await gridfs_driver.DRIVER.put_stream(
                accessor, "a", source(), WriteCondition()
            )
        upload.abort.assert_awaited_once()
        upload.close.assert_not_awaited()
    else:
        meta = await gridfs_driver.DRIVER.put_stream(
            accessor, "a", source(), WriteCondition()
        )
        assert meta.size == 9
        assert meta.revision == "new-id"
        upload.close.assert_awaited_once()
        upload.abort.assert_not_awaited()
    assert closed == [True]


@pytest.mark.asyncio
async def test_retention_prunes_the_oldest_revisions_on_write(
    store: FakeStore,
):
    accessor = make_accessor(keep_revisions=2)
    for data in (b"v1", b"v2"):
        await write(accessor, A_TXT, data)
    kept = store.ids("a.txt")
    # Two revisions never fall below the two kept.
    await write(accessor, A_TXT, b"v3")
    ids = store.ids("a.txt")
    assert ids[:1] == kept[1:]
    assert len(ids) == 2
    assert kept[0] not in store.chunks
    assert store.chunks[ids[-1]] == b"v3"


@pytest.mark.asyncio
async def test_retention_counts_live_and_trashed_revisions_apart(
    store: FakeStore,
):
    accessor = make_accessor(keep_revisions=1)
    await write(accessor, A_TXT, b"v1")
    await write(accessor, A_TXT, b"v2")
    await unlink(accessor, A_TXT)
    assert len(store.ids("/trash/a.txt")) == 1
    await write(accessor, A_TXT, b"v3")
    assert len(store.ids("a.txt")) == 1
    assert len(store.ids("/trash/a.txt")) == 1
    assert store.chunks[store.ids("/trash/a.txt")[0]] == b"v2"


@pytest.mark.asyncio
async def test_retention_breaks_upload_date_ties_by_the_newest_id(
    store: FakeStore,
):
    # Two uploads in one clock tick: the later _id is the newer revision,
    # for reads and for what retention keeps.
    store.upload("a.txt", b"older")
    newer = store.upload("a.txt", b"newer", same_time=True)
    accessor = make_accessor(keep_revisions=1)
    assert await read(accessor, A_TXT) == b"newer"
    await unlink(accessor, A_TXT)
    assert store.ids("/trash/a.txt") == [newer]


@pytest.mark.asyncio
async def test_no_retention_keeps_every_revision(store: FakeStore):
    accessor = make_accessor()
    for data in (b"v1", b"v2", b"v3"):
        await write(accessor, A_TXT, data)
    await unlink(accessor, A_TXT)
    await write(accessor, A_TXT, b"v4")
    assert len(store.ids("/trash/a.txt")) == 3
    assert len(store.chunks) == 4
