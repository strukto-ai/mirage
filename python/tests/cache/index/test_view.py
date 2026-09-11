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
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from mirage.cache.index.config import (IndexConfig, IndexEntry, LookupStatus,
                                       RedisIndexConfig)
from mirage.ops.registry import RegisteredOp
from mirage.resource.ram import RAMResource
from mirage.workspace import Workspace


@pytest.mark.asyncio
@pytest.mark.parametrize("store_kind", ["ram", "redis"])
@pytest.mark.parametrize("phase", ["backend", "store"])
@pytest.mark.parametrize(
    "method", ["put", "set_dir", "seed_get", "seed_list_dir", "seed_entries"])
@pytest.mark.parametrize("shadow", [False, True])
async def test_late_index_write_cannot_cross_mount_ownership(
        monkeypatch, store_kind, phase, method, shadow):
    config = IndexConfig()
    if store_kind == "redis":
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        config = RedisIndexConfig(url=url, key_prefix=f"lifecycle:{uuid4()}:")
    resource = RAMResource()
    prefix = "/" if shadow else "/data"
    ws = Workspace({prefix: resource}, index=config)
    ws.add_mount("/alias", resource)
    index = resource.index
    entry = IndexEntry(id="old", name="stale", resource_type="file")
    entered = asyncio.Event()
    release = asyncio.Event()

    async def pause():
        entered.set()
        await release.wait()

    if phase == "store":
        store_method = method.removeprefix("seed_")
        original = getattr(index, store_method)

        async def delayed_store(*args, **kwargs):
            await pause()
            return await original(*args, **kwargs)

        monkeypatch.setattr(index, store_method, delayed_store)

    async def delayed_readdir(_accessor, _path, *, index, **_kwargs):
        if phase == "backend":
            await pause()
        if method == "put":
            await index.put("/data/stale", entry)
        elif method == "set_dir":
            await index.set_dir("/data", [("stale", entry)])
        else:
            index.seed({"/data/stale": entry}, {"/data": ["/data/stale"]},
                       datetime.now(timezone.utc) + timedelta(hours=1))
            if method == "seed_get":
                await index.get("/data/stale")
            elif method == "seed_list_dir":
                await index.list_dir("/data")
            else:
                await index.entries()
        return ["/data/stale"]

    ws.mount(prefix).register_op(
        RegisteredOp(name="readdir",
                     resource="ram",
                     filetype=None,
                     fn=delayed_readdir))
    reading = asyncio.create_task(ws.fs.readdir("/data"))
    changing = None
    replacement = RAMResource()
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        if shadow:
            ws.add_mount("/data", replacement)
            changing = asyncio.create_task(ws.fs.readdir("/data"))
        else:
            changing = asyncio.create_task(ws.unmount("/data"))
        await asyncio.sleep(0)
        if phase == "store":
            assert not changing.done()
            release.set()
        await asyncio.wait_for(changing, timeout=5)
        if not shadow:
            ws.add_mount("/data", replacement)
            await ws.fs.readdir("/data")
        fresh = IndexEntry(id="new", name="fresh", resource_type="file")
        await replacement.index.put("/data/fresh", fresh)
        release.set()
        await asyncio.wait_for(reading, timeout=5)
        for candidate in (index, replacement.index):
            assert (
                await
                candidate.get("/data/stale")).status == LookupStatus.NOT_FOUND
            assert "/data/stale" not in ((await
                                          candidate.list_dir("/data")).entries
                                         or [])
        assert (await replacement.index.get("/data/fresh")).entry.id == "new"
    finally:
        release.set()
        await asyncio.gather(reading,
                             *([changing] if changing else []),
                             return_exceptions=True)
        await index.clear()
        await ws.close()
