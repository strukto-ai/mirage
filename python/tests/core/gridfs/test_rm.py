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
from mirage.core.gridfs.rm import rm_r
from mirage.types import PathSpec
from tests.fixtures.gridfs_store import FakeStore, make_accessor


def _spec(key: str) -> PathSpec:
    return PathSpec(vfs_path=key, virtual=f"/mnt/{key}", directory="/mnt")


@pytest.mark.asyncio
async def test_rm_r_trashes_the_subtree_and_its_marker(store: FakeStore):
    for name in ("d/", "d/f.txt", "d/f.txt", "d/sub/g.txt", "keep.txt"):
        store.upload(name, b"x")
    ids = {name: store.ids(name) for name in ("d/f.txt", "d/sub/g.txt")}
    accessor = make_accessor()
    await rm_r(accessor, _spec("d"))
    assert sorted(store.names()) == [
        "/trash/d/",
        "/trash/d/f.txt",
        "/trash/d/f.txt",
        "/trash/d/sub/g.txt",
        "keep.txt",
    ]
    assert store.ids("/trash/d/f.txt") == ids["d/f.txt"]
    assert store.ids("/trash/d/sub/g.txt") == ids["d/sub/g.txt"]
    rows = await readdir(accessor, _spec(""))
    assert [row.name for row in rows] == ["keep.txt"]


@pytest.mark.asyncio
async def test_rm_r_with_retention_prunes_the_trash(store: FakeStore):
    for name in ("d/f.txt", "d/f.txt", "d/f.txt", "d/g.txt"):
        store.upload(name, b"x")
    f_ids = store.ids("d/f.txt")
    await rm_r(make_accessor(keep_revisions=2), _spec("d"))
    assert store.ids("/trash/d/f.txt") == f_ids[1:]
    assert len(store.ids("/trash/d/g.txt")) == 1
    assert f_ids[0] not in store.chunks
