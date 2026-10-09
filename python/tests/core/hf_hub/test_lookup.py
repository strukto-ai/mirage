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
from unittest.mock import AsyncMock

import pytest
from fakeredis.aioredis import FakeRedis

import mirage.core.hf_hub.lookup as lookup_mod
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import NULL_INDEX, IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.core.hf_hub.lookup import (
    dir_stat_entry,
    key_of,
    lookup,
    probe_dir,
    probe_file,
)
from mirage.core.hf_hub.read import read, resolve_entry
from mirage.core.hf_hub.stat import stat
from mirage.core.hf_hub.tree import parse_entry, refill_index, seed_index
from tests.core.hf_hub.conftest import file_row, ps, seed
from tests.fixtures.github_api import expired_on_arrival


@pytest.mark.parametrize(
    "prefix,local,expected",
    [
        ("", "a.txt", "/a.txt"),
        ("", "", "/"),
        ("/m", "a.txt", "/m/a.txt"),
        ("/m", "", "/m"),
        ("/m", "/d/a.txt", "/m/d/a.txt"),
    ],
)
def test_key_of_builds_a_mount_absolute_key(prefix, local, expected):
    assert key_of(prefix, local) == expected


@pytest.mark.asyncio
async def test_lookup_answers_from_the_tree_without_an_index(loaded):
    found = await lookup(loaded, NULL_INDEX, "", "/a.txt")
    assert found.exists and not found.is_dir
    assert found.entry.size == 7


@pytest.mark.asyncio
async def test_lookup_and_the_index_agree(loaded):
    """Both paths are built by index_rows, so they cannot disagree."""
    index = RAMIndexCacheStore()
    seed_index(loaded.tree, index, "")
    without = await lookup(loaded, NULL_INDEX, "", "/d")
    with_index = await lookup(loaded, index, "", "/d")
    assert without.is_dir and with_index.is_dir
    assert without.children == with_index.children == ["/d/b.txt"]


@pytest.mark.asyncio
async def test_lookup_gives_a_directory_with_no_tree_row_a_folder_row(
    accessor,
):
    # A directory the tree only implies gets a folder row of its own, so
    # its parent lists it and every listed path has an entry (Task 1.3).
    seed(accessor, file_row("d/b.txt"))
    found = await lookup(accessor, NULL_INDEX, "", "/d")
    assert found.is_dir is True
    assert found.entry is not None
    assert (found.entry.resource_type, found.entry.id) == ("folder", "")
    assert found.exists is True


@pytest.mark.asyncio
async def test_lookup_reports_an_absence(loaded):
    found = await lookup(loaded, NULL_INDEX, "", "/nope")
    assert found.exists is False
    assert found.is_dir is False


@pytest.mark.asyncio
async def test_probes_tell_a_file_from_a_directory(loaded):
    assert await probe_file(loaded, NULL_INDEX, "", "a.txt") is True
    assert await probe_dir(loaded, NULL_INDEX, "", "a.txt") is False
    assert await probe_dir(loaded, NULL_INDEX, "", "d") is True
    assert await probe_file(loaded, NULL_INDEX, "", "d") is False
    assert await probe_file(loaded, NULL_INDEX, "", "nope") is False


def test_dir_stat_entry_names_the_last_segment():
    entry = dir_stat_entry("/m/deep/dir")
    assert entry.name == "dir"
    assert entry.resource_type == "folder"


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("changed", ["a.txt", "d/b.txt", "d"])
@pytest.mark.parametrize("deleted", [True, False])
async def test_direct_lookup_refreshes_invalidated_snapshot(
    loaded, backend, changed, deleted, monkeypatch
):
    client = FakeRedis()
    index = (
        RAMIndexCacheStore()
        if backend == "ram"
        else RedisIndexCacheStore(client=client)
    )
    tree = dict(loaded.tree)
    for key in list(tree):
        if key == changed or key.startswith(changed + "/"):
            tree.pop(key)
    if not deleted:
        tree[changed] = parse_entry(file_row(changed, 42, oid="new-oid"))
    fetch = AsyncMock(return_value=tree)
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    try:
        seed_index(loaded.tree, index, "/m")
        await index.set_dir(
            "/other",
            [
                (
                    "keep",
                    IndexEntry(id="keep", name="keep", resource_type="file"),
                )
            ],
        )
        await index.invalidate()
        path = ps(changed, "/m")
        for _ in range(2):
            if deleted:
                for reader in (stat, read):
                    with pytest.raises(FileNotFoundError):
                        await reader(loaded, path, index)
            else:
                result = await stat(loaded, path, index)
                assert result.size == 42
                assert result.fingerprint == "new-oid"
        if changed == "d":
            assert not (await lookup(loaded, index, "/m", "/m/d/b.txt")).exists
        fetch.assert_awaited_once()
        assert (await index.get("/other/keep")).entry.id == "keep"
    finally:
        await index.close()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_parallel_snapshot_readers_share_one_replacement(
    loaded, backend, monkeypatch
):
    client = FakeRedis()
    index = (
        RAMIndexCacheStore()
        if backend == "ram"
        else RedisIndexCacheStore(client=client)
    )
    fresh = {"a.txt": parse_entry(file_row("a.txt", 42, oid="new"))}

    async def fetch(*args):
        await asyncio.sleep(0)
        return fresh

    fetch_mock = AsyncMock(side_effect=fetch)
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch_mock)
    try:
        seed_index(loaded.tree, index, "/m")
        await index.invalidate()
        keys = ["/m/a.txt", "/m"] * 4
        results = await asyncio.gather(
            *(lookup(loaded, index, "/m", key) for key in keys)
        )
        assert all(row.exists for row in results)
        assert [row.entry.id for row in results[::2]] == ["new"] * 4
        assert [row.children for row in results[1::2]] == [["/m/a.txt"]] * 4
        fetch_mock.assert_awaited_once()
    finally:
        await index.close()
        await client.aclose()


# An index a concurrent probe clears between the refill and the read: the
# first get clears the store, as a reconcile verdict landing in that window
# would, and then answers from the now-empty store.
class _ClearedMidLookup(RAMIndexCacheStore):
    def __init__(self) -> None:
        super().__init__(ttl=600)
        self.gets = 0
        self.cleared = False

    async def get(self, key):
        self.gets += 1
        if not self.cleared:
            self.cleared = True
            await self.clear()
        return await super().get(key)


def _tree(*rows):
    return {r["path"]: parse_entry(r) for r in rows}


@pytest.mark.asyncio
async def test_a_read_retries_when_the_index_is_cleared_under_it(
    accessor, monkeypatch
):
    fetch = AsyncMock(return_value=_tree(file_row("a.txt", 7)))
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    index = _ClearedMidLookup()
    entry = await resolve_entry(accessor, ps("a.txt"), index)
    # Without the retry the cleared store answers "no such file", and
    # through a dispatcher that drops the file's overlay for good.
    assert entry.size == 7
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_a_stat_retries_when_the_index_is_cleared_under_it(
    accessor, monkeypatch
):
    fetch = AsyncMock(return_value=_tree(file_row("a.txt", 7)))
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    index = _ClearedMidLookup()
    accessor.tree = _tree(file_row("a.txt", 7))
    accessor.tree_loaded = True
    seed_index(accessor.tree, index, "")
    # The root is live when stat starts, so the one-path route stands
    # aside and the clear lands inside the ordinary lookup.
    result = await stat(accessor, ps("a.txt"), index)
    assert result.size == 7
    assert fetch.await_count == 1


@pytest.mark.asyncio
async def test_a_genuine_miss_on_a_live_index_asks_once(accessor):
    index = _ClearedMidLookup()
    index.cleared = True
    accessor.tree = _tree(file_row("a.txt", 7))
    accessor.tree_loaded = True
    seed_index(accessor.tree, index, "")
    with pytest.raises(FileNotFoundError):
        await stat(accessor, ps("nope"), index)
    assert index.gets == 1


@pytest.mark.asyncio
async def test_a_miss_without_an_index_is_not_retried(accessor, monkeypatch):
    accessor.tree = _tree(file_row("a.txt", 7))
    accessor.tree_loaded = True
    calls = []
    real = lookup_mod.local_rows

    async def counting(*args, **kwargs):
        calls.append(args)
        return await real(*args, **kwargs)

    monkeypatch.setattr(lookup_mod, "local_rows", counting)
    # NULL_INDEX answers NOT_FOUND to every listing, so a retry keyed on
    # that alone would ask twice for every miss.
    with pytest.raises(FileNotFoundError):
        await resolve_entry(accessor, ps("nope"), NULL_INDEX)
    assert len(calls) == 1


class _ClearedAndReseeded(RAMIndexCacheStore):
    def __init__(self, accessor) -> None:
        super().__init__(ttl=600)
        self.accessor = accessor
        self.raced = False

    # The miss is read from the cleared store, and another op reseeds it
    # before this lookup looks at the root, so the root alone reads live.
    async def get(self, key):
        if self.raced:
            return await super().get(key)
        self.raced = True
        await self.clear()
        missed = await super().get(key)
        await refill_index(self.accessor, self, "")
        return missed


@pytest.mark.asyncio
async def test_a_read_retries_when_a_reseed_hides_the_clear(
    accessor, monkeypatch
):
    fetch = AsyncMock(return_value=_tree(file_row("a.txt", 7)))
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    index = _ClearedAndReseeded(accessor)
    entry = await resolve_entry(accessor, ps("a.txt"), index)
    assert entry.size == 7


@pytest.mark.asyncio
async def test_lookup_answers_from_the_refill_it_just_made(
    loaded, monkeypatch
):
    fetch = AsyncMock(return_value=dict(loaded.tree))
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    refills = loaded.refills
    found = await lookup(loaded, expired_on_arrival(), "/m", "/m/d")
    assert (found.entry.id, found.children) == ("tree-d", ["/m/d/b.txt"])
    assert loaded.refills - refills == 1
    fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_lookup_of_an_expired_folder_under_a_live_root_refills_it(
    loaded, monkeypatch
):
    index = expired_on_arrival("/m")
    seed_index(loaded.tree, index, "/m")
    fetch = AsyncMock(return_value=dict(loaded.tree))
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    refills = loaded.refills
    found = await lookup(loaded, index, "/m", "/m/d")
    assert (found.entry.id, found.children) == ("tree-d", ["/m/d/b.txt"])
    assert loaded.refills - refills == 1
    fetch.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["/m/d", "/m/d/b.txt"])
async def test_refill_snapshot_respects_child_ownership(
    loaded, monkeypatch, key
):
    fetch = AsyncMock(return_value=dict(loaded.tree))
    monkeypatch.setattr("mirage.core.hf_hub.tree.fetch_tree", fetch)
    view = IndexView(
        expired_on_arrival(),
        RAMFileCacheStore(),
        "/m",
        lambda path: path != "/m/d/b.txt",
    )
    found = await lookup(loaded, view, "/m", key)
    if key == "/m/d":
        assert found.entry.id == "tree-d"
        assert found.children == []
    else:
        assert not found.exists
    fetch.assert_awaited_once()
