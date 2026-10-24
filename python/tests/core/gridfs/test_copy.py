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

from mirage.core.gridfs.copy import copy
from mirage.core.gridfs.read import read
from mirage.core.gridfs.write import write
from mirage.types import PathSpec
from tests.fixtures.gridfs_store import FakeStore, make_accessor


def _spec(key: str) -> PathSpec:
    return PathSpec(vfs_path=key, virtual=f"/mnt/{key}", directory="/mnt")


@pytest.mark.asyncio
async def test_copy_onto_one_destination_keeps_the_retention_limit(
    store: FakeStore,
):
    accessor = make_accessor(keep_revisions=1)
    for data in (b"v1", b"v2", b"v3"):
        await write(accessor, _spec("a.txt"), data)
        await copy(accessor, _spec("a.txt"), _spec("b.txt"))
    assert len(store.ids("b.txt")) == 1
    assert await read(accessor, _spec("b.txt")) == b"v3"


@pytest.mark.asyncio
async def test_copy_without_retention_keeps_every_revision(store: FakeStore):
    accessor = make_accessor()
    for data in (b"v1", b"v2"):
        await write(accessor, _spec("a.txt"), data)
        await copy(accessor, _spec("a.txt"), _spec("b.txt"))
    assert len(store.ids("b.txt")) == 2
