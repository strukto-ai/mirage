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
from mirage.cache.index import (
    IndexConfig,
    RAMIndexCacheStore,
    RedisIndexCacheStore,
    RedisIndexConfig,
)
from mirage.cache.index.config import LookupStatus
from mirage.config import MountBlock, RedisIndexBlock, WorkspaceConfig
from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount import registry as mount_registry
from mirage.workspace.mount.spec import Mount

FRESH = ReadSpec(policy=ReadPolicy.FRESH)


def test_redis_index_config_default_key_prefix():
    assert RedisIndexConfig().key_prefix == "mirage:index:"


def test_workspace_index_param_applies_to_mounts():
    ws = Workspace(
        {"/m": RAMVFS()},
        index=RedisIndexConfig(url="redis://localhost:6379/0"),
    )
    assert isinstance(ws.mount("/m/").index_store, RedisIndexCacheStore)


def test_workspace_default_index_is_ram():
    ws = Workspace({"/m": RAMVFS()})
    assert isinstance(ws.mount("/m/").index_store, RAMIndexCacheStore)


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
    entry = ws.add_mount("/late", RAMVFS())
    try:
        assert isinstance(entry.index_store, RedisIndexCacheStore)
    finally:
        await ws.close()


# A mount that names its own index keeps it, whatever the workspace
# config says (#1012): the placement is where the store is chosen.
@pytest.mark.asyncio
async def test_mount_own_index_wins_over_the_workspace_config():
    own = RedisIndexConfig(url="redis://127.0.0.1:1/0", key_prefix="own:")
    ws = Workspace(
        {"/own": Mount(vfs=RAMVFS(), index=own), "/shared": RAMVFS()},
        index=IndexConfig(ttl=5),
    )
    try:
        assert isinstance(ws.mount("/own/").index_store, RedisIndexCacheStore)
        assert isinstance(ws.mount("/shared/").index_store, RAMIndexCacheStore)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_added_mount_inherits_index_ttl():
    ws = Workspace({"/initial": RAMVFS()}, index=IndexConfig(ttl=-1))
    ws.add_mount("/late", RAMVFS())
    try:
        for prefix in ("/initial/", "/late/"):
            store = ws.mount(prefix).index_store
            await store.set_dir("/listing", [])
            assert (
                await store.list_dir("/listing")
            ).status == LookupStatus.EXPIRED
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_added_mount_keeps_index_coherent_across_aliases_and_duplicates():
    ws = Workspace({}, index=IndexConfig(ttl=3600))
    vfs = RAMVFS()
    entry = ws.add_mount("/late", vfs, MountMode.WRITE)
    index = entry.index_store
    rejected = RAMVFS()
    try:
        await index.set_dir("/late", [])
        alias = ws.add_mount("/alias", vfs)
        # An alias runs under the store its instance already has.
        assert alias.index_store is index
        assert (await index.list_dir("/late")).entries == []
        with pytest.raises(ValueError, match="duplicate mount prefix"):
            ws.add_mount("late/", rejected)
        # The manager must invalidate the configured index, not a store
        # the VFS had before it was attached to the workspace.
        await ws.vfs.write("/late/new.txt", b"new")
        assert (await index.list_dir("/late")).status == LookupStatus.NOT_FOUND
    finally:
        await ws.close()
        await rejected.close()


@pytest.mark.asyncio
async def test_added_mount_runs_the_index_it_names(tmp_path):
    ws = Workspace({}, index=IndexConfig(ttl=73))
    try:
        entry = ws.add_mount(
            "/b", DiskVFS(root=str(tmp_path)), index=IndexConfig(ttl=37)
        )
        assert entry.index_store.ttl == 37
        assert entry.index_config == IndexConfig(ttl=37)
    finally:
        await ws.close()


# RAM keeps no listings of its own (index_ttl 0), so fresh on it is
# accepted only because of the index the call names; disk's listing
# cache is taken away by a zero index under a nonzero workspace one.
@pytest.mark.asyncio
async def test_added_mount_is_judged_on_the_index_it_names(tmp_path):
    ws = Workspace({})
    try:
        entry = ws.add_mount(
            "/r", RAMVFS(), read=FRESH, index=IndexConfig(ttl=30)
        )
        assert entry.read.policy is ReadPolicy.FRESH
    finally:
        await ws.close()
    ws = Workspace({}, index=IndexConfig(ttl=73))
    try:
        with pytest.raises(
            ValueError, match="'/d'.*caches reads or listings"
        ):
            ws.add_mount(
                "/d",
                DiskVFS(root=str(tmp_path)),
                read=FRESH,
                index=IndexConfig(ttl=0),
            )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_refused_added_mount_builds_no_index_store(
    tmp_path, monkeypatch
):
    ws = Workspace({})
    built: list[IndexConfig | None] = []
    real = mount_registry.build_index

    def recording(config: IndexConfig | None, ttl: float):
        built.append(config)
        return real(config, ttl)

    monkeypatch.setattr(mount_registry, "build_index", recording)
    try:
        with pytest.raises(ValueError, match="caches reads or listings"):
            ws.add_mount(
                "/d",
                DiskVFS(root=str(tmp_path)),
                read=FRESH,
                index=RedisIndexConfig(url="redis://127.0.0.1:1/0", ttl=0),
            )
        # The verdict runs before the registry builds a store, so a
        # refused call leaves no Redis client behind and no mount.
        assert built == []
        assert ws._registry.try_mount_for_prefix("/d/") is None
    finally:
        await ws.close()


# Two mounts of one instance run one store, the first one's: the same
# rule the constructor applies, so an alias's own index goes unused and
# fresh is judged on the store it shares. RAM (index_ttl 0, no
# workspace index) makes the shared 37 the only answer that accepts.
@pytest.mark.asyncio
async def test_added_alias_shares_the_first_mount_index():
    ram = RAMVFS()
    ws = Workspace({"/a": Mount(ram, index=IndexConfig(ttl=37))})
    try:
        first = ws.mount("/a/")
        alias = ws.add_mount("/b", ram, index=IndexConfig(ttl=0))
        assert alias.index_store is first.index_store
        assert alias.index_config == IndexConfig(ttl=37)
        judged = ws.add_mount(
            "/c", ram, read=FRESH, index=IndexConfig(ttl=0)
        )
        assert judged.read.policy is ReadPolicy.FRESH
    finally:
        await ws.close()
