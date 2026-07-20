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

import pytest

from mirage.runtime.wasm.bridge import SyncDispatch
from mirage.types import PathSpec
from mirage.utils.errors import enotsup


def test_sync_dispatch_bridges_to_the_loop_and_maps_missing_ops():

    async def dispatch(op, path, **kwargs):
        if op == "boom":
            raise enotsup("ram", "boom", path)
        return (op, path.virtual, kwargs), None

    async def run():
        loop = asyncio.get_running_loop()
        sync = SyncDispatch(dispatch, loop)
        result = await asyncio.to_thread(sync.call, "read", "/data/f.txt")
        assert result == ("read", "/data/f.txt", {})
        with pytest.raises(NotImplementedError, match="no op 'boom'"):
            await asyncio.to_thread(sync.call, "boom", "/data/f.txt")

    asyncio.run(run())


def test_sync_dispatch_wraps_paths_as_pathspec():
    seen = []

    async def dispatch(op, path, **kwargs):
        seen.append(path)
        return None, None

    async def run():
        sync = SyncDispatch(dispatch, asyncio.get_running_loop())
        await asyncio.to_thread(sync.call, "stat", "/data/f.txt")

    asyncio.run(run())
    assert isinstance(seen[0], PathSpec)
    assert seen[0].virtual == "/data/f.txt"
