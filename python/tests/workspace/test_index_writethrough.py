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

import asyncio

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


class _FakeRemote(RAMResource):
    is_remote = True
    index_ttl = 600


def _seed_remote() -> _FakeRemote:
    remote = _FakeRemote()
    remote._store.dirs.add("/data")
    remote._store.files["/data/a.txt"] = b"a"
    return remote


def test_dispatch_write_invalidates_parent_dir_index():
    remote = _seed_remote()
    ws = Workspace({"/r": (remote, MountMode.WRITE)}, mode=MountMode.WRITE)

    async def run():
        before = await ws.readdir("/r/data")
        scope = PathSpec(
            original="/r/data/b.txt",
            directory="/r/data",
            prefix="/r",
            resolved=True,
        )
        await ws.dispatch("write", scope, data=b"b")
        after = await ws.readdir("/r/data")
        return before, after

    before, after = asyncio.run(run())
    assert "/r/data/a.txt" in before
    assert "/r/data/b.txt" in after, (
        "after dispatch write, readdir should reflect b.txt; "
        f"got {after!r}")


def test_dispatch_unlink_invalidates_parent_dir_index():
    remote = _seed_remote()
    remote._store.files["/data/c.txt"] = b"c"
    ws = Workspace({"/r": (remote, MountMode.WRITE)}, mode=MountMode.WRITE)

    async def run():
        before = await ws.readdir("/r/data")
        scope = PathSpec(
            original="/r/data/c.txt",
            directory="/r/data",
            prefix="/r",
            resolved=True,
        )
        await ws.dispatch("unlink", scope)
        after = await ws.readdir("/r/data")
        return before, after

    before, after = asyncio.run(run())
    assert "/r/data/c.txt" in before
    assert "/r/data/c.txt" not in after, (
        "after dispatch unlink, readdir should drop c.txt; "
        f"got {after!r}")
