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

import pytest

from mirage.core.gridfs.exists import exists
from mirage.core.gridfs.read import read
from mirage.core.gridfs.readdir import readdir, tree
from mirage.core.gridfs.stat import stat
from mirage.core.gridfs.stream import read_stream
from mirage.core.gridfs.unlink import unlink
from mirage.core.gridfs.write import write
from mirage.observe.context import push_revisions, reset_revisions
from mirage.types import PathSpec
from tests.fixtures.gridfs_store import FakeStore, make_accessor

A_TXT = PathSpec(vfs_path="a.txt", virtual="/mnt/a.txt", directory="/mnt")
ROOT = PathSpec(vfs_path="", virtual="/mnt/", directory="/mnt/")


async def _seed_and_rm(store: FakeStore) -> list:
    accessor = make_accessor()
    await write(accessor, A_TXT, b"v1")
    await write(accessor, A_TXT, b"v2")
    ids = store.ids("a.txt")
    await unlink(accessor, A_TXT)
    return ids


@pytest.mark.asyncio
async def test_rm_moves_every_revision_to_the_trash(store: FakeStore):
    """``rm`` retags the revisions the way ``mv`` does, so each keeps
    its ``_id`` and its chunks: the issue's snapshot pinned to an older
    revision still names a document."""
    ids = await _seed_and_rm(store)
    assert store.names() == ["/trash/a.txt", "/trash/a.txt"]
    assert store.ids("/trash/a.txt") == ids
    assert set(store.chunks) == set(ids)


@pytest.mark.asyncio
async def test_rm_then_pinned_read_still_works(store: FakeStore):
    first, _ = await _seed_and_rm(store)
    token = push_revisions({A_TXT.virtual: str(first)})
    try:
        assert await read(make_accessor(), A_TXT) == b"v1"
        chunks = [c async for c in read_stream(make_accessor(), A_TXT)]
    finally:
        reset_revisions(token)
    assert b"".join(chunks) == b"v1"


@pytest.mark.asyncio
async def test_rm_then_the_name_reads_as_gone(store: FakeStore):
    await _seed_and_rm(store)
    accessor = make_accessor()
    assert await readdir(accessor, ROOT) == []
    assert not await tree(accessor, ROOT)
    assert await exists(accessor, A_TXT) is False
    with pytest.raises(FileNotFoundError):
        await stat(accessor, A_TXT)
    with pytest.raises(FileNotFoundError):
        await read(accessor, A_TXT)
    with pytest.raises(FileNotFoundError):
        await unlink(accessor, A_TXT)


@pytest.mark.asyncio
async def test_write_after_rm_starts_a_fresh_revision(store: FakeStore):
    old = await _seed_and_rm(store)
    accessor = make_accessor()
    await write(accessor, A_TXT, b"v3")
    assert await read(accessor, A_TXT) == b"v3"
    assert [row.name for row in await readdir(accessor, ROOT)] == ["a.txt"]
    (fresh,) = store.ids("a.txt")
    assert fresh not in old
    assert (await stat(accessor, A_TXT)).fingerprint == str(fresh)
    assert store.ids("/trash/a.txt") == old
