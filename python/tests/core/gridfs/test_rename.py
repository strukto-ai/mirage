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

from mirage.core.gridfs.readdir import readdir
from mirage.core.gridfs.rename import rename
from mirage.core.gridfs.unlink import unlink
from mirage.core.gridfs.write import write
from mirage.types import PathSpec
from tests.fixtures.gridfs_store import FakeStore, make_accessor


def _spec(key: str) -> PathSpec:
    return PathSpec(vfs_path=key, virtual=f"/mnt/{key}", directory="/mnt")


@pytest.mark.asyncio
async def test_rename_moves_a_whole_directory_prefix(store: FakeStore):
    """A directory owns no revision, so the prefix retag has to carry it.

    Before this, a directory operand fell straight through to ENOENT and
    ``mv`` reported "No such file or directory" for a directory that
    ``ls`` had just listed.
    """
    for name in ("d/", "d/f.txt", "d/sub/g.txt", "keep.txt"):
        store.upload(name, b"")
    await rename(make_accessor(), _spec("d"), _spec("e"))
    assert store.names() == ["e/", "e/f.txt", "e/sub/g.txt", "keep.txt"]


@pytest.mark.asyncio
async def test_rename_directory_replaces_an_empty_destination(
    store: FakeStore,
):
    for name in ("src/", "src/f.txt", "dst/"):
        store.upload(name, b"")
    await rename(make_accessor(), _spec("src"), _spec("dst"))
    assert sorted(store.names()) == ["/trash/dst/", "dst/", "dst/f.txt"]


@pytest.mark.asyncio
async def test_rename_keeps_moving_a_plain_file(store: FakeStore):
    store.upload("a.txt", b"")
    await rename(make_accessor(), _spec("a.txt"), _spec("b.txt"))
    assert store.names() == ["b.txt"]


@pytest.mark.asyncio
async def test_rename_missing_source_raises_enoent(store: FakeStore):
    store.upload("other.txt", b"")
    with pytest.raises(FileNotFoundError):
        await rename(make_accessor(), _spec("ghost"), _spec("e"))
    assert store.names() == ["other.txt"]


@pytest.mark.asyncio
async def test_rename_over_a_file_trashes_its_revisions(store: FakeStore):
    # An overwriting mv destroys no more than rm does: the destination's
    # revisions go to the trash, where a pinned read still finds them.
    for name, data in (("a.txt", b"a"), ("b.txt", b"b1"), ("b.txt", b"b2")):
        store.upload(name, data)
    old = store.ids("b.txt")
    await rename(make_accessor(), _spec("a.txt"), _spec("b.txt"))
    assert sorted(store.names()) == ["/trash/b.txt", "/trash/b.txt", "b.txt"]
    assert store.ids("/trash/b.txt") == old


@pytest.mark.asyncio
async def test_rename_does_not_resurrect_trashed_revisions(store: FakeStore):
    accessor = make_accessor()
    await write(accessor, _spec("a.txt"), b"old")
    await unlink(accessor, _spec("a.txt"))
    await write(accessor, _spec("a.txt"), b"new")
    (fresh,) = store.ids("a.txt")
    await rename(accessor, _spec("a.txt"), _spec("b.txt"))
    assert store.ids("b.txt") == [fresh]
    assert len(store.ids("/trash/a.txt")) == 1
    rows = await readdir(accessor, _spec(""))
    assert [row.name for row in rows] == ["b.txt"]
