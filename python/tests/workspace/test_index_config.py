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
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS


def test_redis_index_config_default_key_prefix():
    assert RedisIndexConfig().key_prefix == "mirage:index:"


def test_workspace_index_param_applies_to_mounts():
    r = RAMVFS()
    Workspace({"/m": r},
              index=RedisIndexConfig(url="redis://localhost:6379/0"))
    assert isinstance(r.index, RedisIndexCacheStore)


def test_workspace_default_index_is_ram():
    r = RAMVFS()
    Workspace({"/m": r})
    assert isinstance(r.index, RAMIndexCacheStore)


@pytest.mark.asyncio
async def test_config_index_redis_block_builds_redis_config():
    cfg = WorkspaceConfig(
        mounts={"/m": MountBlock(vfs="ram")},
        index=RedisIndexBlock(type="redis"),
    )
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["index"], RedisIndexConfig)
    assert kwargs["index"].key_prefix == "mirage:index:"


@pytest.mark.asyncio
async def test_added_mount_inherits_redis_index():
    ws = Workspace({}, index=RedisIndexConfig(key_prefix="shared:"))
    vfs = RAMVFS()
    ws.add_mount("/late", vfs)
    try:
        assert isinstance(vfs.index, RedisIndexCacheStore)
    finally:
        await ws.close()


# A VFS keeps the index it was given when the workspace has no index
# config (#1012), on the dynamic path as on construction.
@pytest.mark.asyncio
async def test_added_mount_keeps_a_vfs_own_index_without_a_config():
    ws = Workspace({})
    vfs = RAMVFS()
    vfs.set_index(
        RedisIndexConfig(url="redis://127.0.0.1:1/0", key_prefix="own:"))
    own = vfs.index
    ws.add_mount("/late", vfs)
    try:
        assert vfs.index is own
        assert isinstance(vfs.index, RedisIndexCacheStore)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_added_mount_inherits_index_ttl():
    initial = RAMVFS()
    ws = Workspace({"/initial": initial}, index=IndexConfig(ttl=-1))
    added = RAMVFS()
    ws.add_mount("/late", added)
    try:
        for vfs in (initial, added):
            await vfs.index.set_dir("/listing", [])
            assert (await vfs.index.list_dir("/listing")).status == \
                LookupStatus.EXPIRED
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_added_mount_keeps_index_coherent_across_aliases_and_duplicates(
):
    ws = Workspace({}, index=IndexConfig(ttl=3600))
    vfs = RAMVFS()
    ws.add_mount("/late", vfs, MountMode.WRITE)
    index = vfs.index
    rejected = RAMVFS()
    rejected_index = rejected.index
    try:
        await index.set_dir("/late", [])
        ws.add_mount("/alias", vfs)
        assert vfs.index is index
        assert (await index.list_dir("/late")).entries == []
        with pytest.raises(ValueError, match="duplicate mount prefix"):
            ws.add_mount("late/", rejected)
        assert rejected.index is rejected_index
        # The manager must invalidate the configured index, not the store
        # the VFS had before it was attached to the workspace.
        await ws.vfs.write("/late/new.txt", b"new")
        assert (await index.list_dir("/late")).status == LookupStatus.NOT_FOUND
    finally:
        await ws.close()
        await rejected.close()
