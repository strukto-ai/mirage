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

from mirage import Workspace
from mirage.cache.index import (IndexConfig, RAMIndexCacheStore,
                                RedisIndexCacheStore, RedisIndexConfig)
from mirage.cache.index.config import LookupStatus
from mirage.config import MountBlock, RedisIndexBlock, WorkspaceConfig
from mirage.resource.ram import RAMResource
from mirage.types import MountMode


def test_redis_index_config_default_key_prefix():
    assert RedisIndexConfig().key_prefix == "mirage:index:"


def test_workspace_index_param_applies_to_mounts():
    r = RAMResource()
    Workspace({"/m": r},
              index=RedisIndexConfig(url="redis://localhost:6379/0"))
    assert isinstance(r.index, RedisIndexCacheStore)


def test_workspace_default_index_is_ram():
    r = RAMResource()
    Workspace({"/m": r})
    assert isinstance(r.index, RAMIndexCacheStore)


@pytest.mark.asyncio
async def test_config_index_redis_block_builds_redis_config():
    cfg = WorkspaceConfig(
        mounts={"/m": MountBlock(resource="ram")},
        index=RedisIndexBlock(type="redis"),
    )
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["index"], RedisIndexConfig)
    assert kwargs["index"].key_prefix == "mirage:index:"


@pytest.mark.asyncio
async def test_added_mount_inherits_redis_index():
    ws = Workspace({}, index=RedisIndexConfig(key_prefix="shared:"))
    resource = RAMResource()
    ws.add_mount("/late", resource)
    try:
        assert isinstance(resource.index, RedisIndexCacheStore)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_added_mount_inherits_index_ttl():
    initial = RAMResource()
    ws = Workspace({"/initial": initial}, index=IndexConfig(ttl=-1))
    added = RAMResource()
    ws.add_mount("/late", added)
    try:
        for resource in (initial, added):
            await resource.index.set_dir("/listing", [])
            assert (await resource.index.list_dir("/listing")).status == \
                LookupStatus.EXPIRED
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_added_mount_keeps_index_coherent_across_aliases_and_duplicates(
):
    ws = Workspace({}, index=IndexConfig(ttl=3600))
    resource = RAMResource()
    ws.add_mount("/late", resource, MountMode.WRITE)
    index = resource.index
    rejected = RAMResource()
    rejected_index = rejected.index
    try:
        await index.set_dir("/late", [])
        ws.add_mount("/alias", resource)
        assert resource.index is index
        assert (await index.list_dir("/late")).entries == []
        with pytest.raises(ValueError, match="duplicate mount prefix"):
            ws.add_mount("late/", rejected)
        assert rejected.index is rejected_index
        # The manager must invalidate the configured index, not the store
        # the resource had before it was attached to the workspace.
        await ws.fs.write("/late/new.txt", b"new")
        assert (await index.list_dir("/late")).status == LookupStatus.NOT_FOUND
    finally:
        await ws.close()
        await rejected.close()
