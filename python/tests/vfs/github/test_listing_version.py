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
import logging
from contextlib import asynccontextmanager

import pytest
from fakeredis.aioredis import FakeRedis

from mirage.cache.index import LookupResult, LookupStatus
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.core.github.config import GitHubConfig
from mirage.core.github.stat import stat
from mirage.types import (
    MountMode,
    PathSpec,
    ReadPolicy,
    ReadSpec,
)
from mirage.utils.clock import ManualClock
from mirage.vfs.github import GitHubVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.reconcile import Reconciler
from tests.fixtures.github_api import FakeGitHub, serve

ROOT = PathSpec(virtual="/gh", directory="/gh", vfs_path="")
LISTED = b"a.txt\nb.txt\nc.txt\n"
GROWN = b"a.txt\nb.txt\nc.txt\nnew.txt\n"


def _three() -> FakeGitHub:
    return FakeGitHub(
        files={f"d{i}/{n}.txt": b"x\n" for i in (1, 2, 3) for n in "abc"}
    )


def _vfs(hub: FakeGitHub, ref: str = "main"):
    return build_vfs(
        "github",
        {
            "token": "t",
            "owner": "o",
            "repo": "r",
            "ref": ref,
            "base_url": hub.url,
        },
    )


def _ws(
    vfs,
    policy: ReadPolicy = ReadPolicy.FRESH,
    index=None,
    clock: ManualClock | None = None,
) -> Workspace:
    ws = Workspace(
        {
            "/gh": Mount(
                vfs=vfs,
                mode=MountMode.READ,
                read=ReadSpec(policy=policy, ttl=600),
            ),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        clock=clock,
    )
    if index is not None:
        ws.mount("/gh").index_store = index
        ws._registry._attach_manager(ws.mount("/gh"))
    return ws


@asynccontextmanager
async def _open(ws: Workspace):
    try:
        yield ws
    finally:
        await ws.close()


async def _out(ws: Workspace, line: str, session_id: str | None = None):
    kwargs = {} if session_id is None else {"session_id": session_id}
    result = await asyncio.wait_for(ws.shell(line, **kwargs), 10)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _stored(ws: Workspace, key: str = "/gh") -> str | None:
    return (await ws.mount("/gh").index_store.list_dir(key)).version


def _count_list_dirs(monkeypatch, store) -> list[str]:
    reads: list[str] = []
    list_dir = store.list_dir

    async def counted(path):
        reads.append(path)
        return await list_dir(path)

    monkeypatch.setattr(store, "list_dir", counted)
    return reads


# Only the gate's check store wants the root's version, so a root stat
# through the mount's own index names none and reads neither the index nor
# the backend, however stale the trust is (it used to answer the stored one).
@pytest.mark.asyncio
@pytest.mark.parametrize("scoped", [True, False])
async def test_a_root_stat_through_the_mount_index_names_no_version(
    monkeypatch, scoped
):
    clock = ManualClock(start=100.0)
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub), clock=clock)) as ws:
            await _out(ws, "ls /gh")
            stored = await _stored(ws)
            clock.advance(LISTING_TRUST_WINDOW * 2)
            hub.log.clear()
            mount = ws.mount("/gh")
            reads = _count_list_dirs(monkeypatch, mount.index_store)
            if scoped:
                async with command_scope():
                    found = await stat(mount.vfs.accessor, ROOT, mount.index)
            else:
                found = await stat(mount.vfs.accessor, ROOT, mount.index)
            assert stored is not None
            assert found.fingerprint is None
            assert reads == []
            assert hub.counts() == (0, 0, 0)


# Only the gate's check store asks the head, so a root stat through the
# mount's own index sends nothing, cold or listed (it used to ask once).
@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
async def test_a_root_stat_before_the_first_listing_asks_nothing(policy):
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub), policy=policy)) as ws:
            assert await _out(ws, "stat -c %n /gh") == b"/gh\n"
            assert hub.counts() == (0, 0, 0)
            await _out(ws, "ls /gh")
            hub.log.clear()
            assert await _out(ws, "stat -c %n /gh") == b"/gh\n"
            assert hub.counts() == (0, 0, 0)


# An add outside mirage moves the head, so the next command's one check
# misses and the tree is fetched once; a glob sees the file.
@pytest.mark.asyncio
async def test_an_outside_add_is_seen_after_one_check_and_one_walk():
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub))) as ws:
            await _out(ws, "ls /gh")
            hub.files["d1/new.txt"] = b"new\n"
            hub.log.clear()
            assert await _out(ws, "echo /gh/d1/*") == (
                b"/gh/d1/a.txt /gh/d1/b.txt /gh/d1/c.txt /gh/d1/new.txt\n"
            )
            assert hub.counts() == (1, 1, 0)


# The version is the head the tree response itself named, so a commit
# landing right after that response is a mismatch for the next command.
@pytest.mark.asyncio
async def test_a_commit_after_the_tree_response_is_caught_next_command():
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub))) as ws:
            hub.after_recursive = lambda: hub.files.setdefault(
                "d1/new.txt", b"new\n"
            )
            assert await _out(ws, "ls /gh/d1") == LISTED
            hub.after_recursive = None
            hub.log.clear()
            assert await _out(ws, "ls /gh/d1") == GROWN
            assert hub.counts() == (1, 1, 0)


# A second workspace re-lists the index both share, so the first one's
# in-memory tree is older than its index. ls, find and grep all read the
# stored listings, so none of them pays for that tree.
# Shared as one RAM store, or as two Redis stores over one server.
@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_a_walk_reads_a_shared_index_newer_than_its_tree(backend):
    client = FakeRedis() if backend == "redis" else None
    shared = RAMIndexCacheStore()

    def store():
        if client is None:
            return shared
        return RedisIndexCacheStore(client=client, key_prefix="shared:")

    with serve(_three()) as hub:
        one, two = _ws(_vfs(hub), index=store()), _ws(_vfs(hub), index=store())
        try:
            await _out(one, "ls /gh")
            hub.files["d1/new.txt"] = b"new x\n"
            await _out(two, "ls /gh/d1")
            hub.log.clear()
            assert await _out(one, "ls /gh/d1") == GROWN
            assert hub.counts() == (1, 0, 0)
            hub.log.clear()
            found = await _out(one, "find /gh -name new.txt")
            assert found == b"/gh/d1/new.txt\n"
            assert hub.counts() == (1, 0, 0)
            assert b"/gh/d1/new.txt" in await _out(one, "grep -rl x /gh")
        finally:
            await one.close()
            await two.close()
            if client is not None:
                await client.aclose()


SHA = "0123456789abcdef0123456789abcdef01234567"


# A full-hex ref pins every listing: the stored version is the pin, so
# the next command serves it with no request. The ref is the effective one,
# the kwarg over the config, and compared lowercased.
def test_the_pin_is_the_effective_ref_lowercased():
    config = GitHubConfig(token="t", owner="o", repo="r", base_url="x")
    assert GitHubVFS(config, ref=SHA.upper()).listings_pin == SHA
    assert GitHubVFS(config).listings_pin is None
    assert GitHubVFS(config, ref="main").listings_pin is None
    pinned = GitHubConfig(
        token="t", owner="o", repo="r", ref=SHA, base_url="x"
    )
    assert GitHubVFS(pinned).listings_pin == SHA


# Only a full SHA-1 or SHA-256 hex string names a commit; one character
# longer is a branch name, so it pins nothing.
def test_only_a_full_length_hex_ref_pins():
    config = GitHubConfig(token="t", owner="o", repo="r", base_url="x")
    assert GitHubVFS(config, ref="c" * 41).listings_pin is None


@pytest.mark.asyncio
async def test_a_mount_pinned_to_a_commit_serves_its_listing_unchecked():
    with serve(_three()) as hub:
        head = hub.head()
        async with _open(_ws(_vfs(hub, ref=head.upper()))) as ws:
            assert await _out(ws, "ls /gh/d1") == LISTED
            assert await _stored(ws) == head
            hub.log.clear()
            assert await _out(ws, "ls /gh/d1") == LISTED
            assert hub.counts() == (0, 0, 0)


# A mount pinned to an older commit, over a store a `main` mount
# filled, must not serve main's listing just because it is pinned.
@pytest.mark.asyncio
async def test_a_pinned_mount_never_serves_another_refs_listing():
    with serve(_three()) as hub:
        old = hub.head()
        shared = RAMIndexCacheStore()
        async with _open(_ws(_vfs(hub), index=shared)) as main:
            await _out(main, "ls /gh/d1")
            hub.files["d1/new.txt"] = b"new\n"
            assert await _out(main, "ls /gh/d1") == GROWN
        async with _open(_ws(_vfs(hub, ref=old), index=shared)) as pinned:
            hub.log.clear()
            assert await _out(pinned, "ls /gh/d1") == LISTED
            assert hub.count("dir") == 1


# A full-sha ref is served unchecked because github.com refuses a 40- or
# 64-hex branch or tag name (an Enterprise host is assumed to as well). A
# hex ref that answers another head is stored at that head, so it never
# matches its pin and an outside change is seen.
@pytest.mark.asyncio
async def test_a_hex_branch_name_is_never_served_as_a_pin():
    ref = "a" * 40
    with serve(_three()) as hub:
        hub.ref = ref
        async with _open(_ws(_vfs(hub, ref=ref))) as ws:
            assert ws.mount("/gh").vfs.listings_pin == ref
            assert await _out(ws, "ls /gh/d1") == LISTED
            hub.files["d1/new.txt"] = b"new\n"
            hub.log.clear()
            assert await _out(ws, "ls /gh/d1") == GROWN
            assert hub.counts() != (0, 0, 0)


# A truncated tree stores no version, pinned or not, so it re-lists
# folder by folder as it did before versions existed.
@pytest.mark.asyncio
async def test_a_truncated_pinned_mount_relists_like_an_unpinned_one():
    costs = []
    for pinned in (False, True):
        with serve(_three()) as hub:
            hub.truncated_recursive = True
            async with _open(
                _ws(_vfs(hub, ref=hub.head() if pinned else "main"))
            ) as ws:
                await _out(ws, "ls /gh/d1")
                assert await _stored(ws, "/gh/d1") is None
                hub.log.clear()
                assert await _out(ws, "ls /gh/d1") == LISTED
                costs.append((hub.counts(), hub.count("dir")))
    assert costs[0] == costs[1]


# A tree response that names no head stores no version, so the next
# command re-lists exactly as before versions existed.
@pytest.mark.asyncio
async def test_a_response_without_a_head_stores_no_version():
    with serve(_three()) as hub:
        hub.drop_sha = True
        async with _open(_ws(_vfs(hub))) as ws:
            await _out(ws, "ls /gh")
            assert await _stored(ws) is None
            assert await _stored(ws, "/gh/d1") is None
            hub.log.clear()
            await _out(ws, "ls /gh/d1")
            assert hub.counts() == (0, 1, 0)


# Tree walks check the version like a listing does, and refill on a miss.
@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["find /gh", "du -a /gh"])
async def test_a_tree_walk_after_an_outside_add_checks_then_walks_once(line):
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub))) as ws:
            await _out(ws, "ls /gh")
            hub.files["d1/new.txt"] = b"new\n"
            hub.log.clear()
            assert b"/gh/d1/new.txt" in await _out(ws, line)
            assert hub.counts() == (1, 1, 0)


async def _drop_row(store, client, key: str) -> None:
    if client is None:
        await store.invalidate_entry(key)
    else:
        await client.delete(store._entry_key(key))


def _store(backend: str):
    client = FakeRedis() if backend == "redis" else None
    if client is None:
        return RAMIndexCacheStore(), None
    return RedisIndexCacheStore(client=client), client


# Eviction can drop a child's row while its listing survives. The store
# still serves the listing; a stat or read of the listed child finds no
# row and refills once, so it answers the child rather than a hole.
@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
async def test_a_listed_child_without_a_row_refills_once(backend, policy):
    store, client = _store(backend)
    with serve(_three()) as hub:
        ws = _ws(_vfs(hub), policy=policy, index=store)
        try:
            await _out(ws, "ls /gh")
            await _drop_row(store, client, "/gh/d1/a.txt")
            hub.log.clear()
            assert await _out(ws, "cat /gh/d1/a.txt") == b"x\n"
            assert hub.count("recursive") == 1
            assert await _out(ws, "stat -c %n /gh/d1/a.txt") == (
                b"/gh/d1/a.txt\n"
            )
            assert await _out(ws, "ls /gh/d1") == LISTED
            assert hub.count("recursive") == 1
        finally:
            await ws.close()
            if client is not None:
                await client.aclose()


# A truncated tree has no whole listing to refill, so the folder that
# names the evicted row is listed again on its own.
@pytest.mark.asyncio
async def test_a_listed_child_without_a_row_in_a_truncated_tree_relists():
    store = RAMIndexCacheStore()
    with serve(_three()) as hub:
        hub.truncated_recursive = True
        async with _open(
            _ws(_vfs(hub), policy=ReadPolicy.BOUNDED, index=store)
        ) as ws:
            assert await _out(ws, "ls /gh/d1") == LISTED
            await store.invalidate_entry("/gh/d1/a.txt")
            hub.log.clear()
            assert await _out(ws, "cat /gh/d1/a.txt") == b"x\n"
            assert hub.count("recursive") == 0
            assert hub.count("dir") >= 1


# A name the live listing does not hold is absent, and costs no refill.
@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_an_unlisted_name_is_absent_without_a_refill(backend):
    store, client = _store(backend)
    with serve(_three()) as hub:
        ws = _ws(_vfs(hub), index=store)
        try:
            await _out(ws, "ls /gh")
            hub.log.clear()
            result = await ws.shell("stat /gh/d1/zz.txt")
            assert result.exit_code == 1
            assert "No such file" in await result.stderr_str()
            assert hub.count("recursive") == 0
        finally:
            await ws.close()
            if client is not None:
                await client.aclose()


# The Redis store serves an unchanged listing on one check, the same as RAM.
@pytest.mark.asyncio
async def test_an_unchanged_listing_on_redis_costs_one_check():
    client = FakeRedis()
    store = RedisIndexCacheStore(client=client)
    with serve(_three()) as hub:
        ws = _ws(_vfs(hub), index=store)
        try:
            await _out(ws, "ls /gh")
            hub.log.clear()
            assert await _out(ws, "ls /gh/d1") == LISTED
            assert hub.counts() == (1, 0, 0)
        finally:
            await ws.close()
            await client.aclose()


# A backend that cannot be reached answers EXPIRED at the gate, logged,
# and the listing stays stored for the re-list to diff.
@pytest.mark.asyncio
async def test_an_unreachable_backend_keeps_the_listing(caplog):
    caplog.set_level(logging.DEBUG, logger="mirage.workspace.reconcile")
    with serve(_three()) as hub:
        ws = _ws(_vfs(hub))
        await _out(ws, "ls /gh")
    try:
        mount = ws.mount("/gh")
        stored = await mount.index_store.list_dir("/gh/d1")
        rec = Reconciler(ws.cache, ws.namespace)
        async with command_scope():
            assert (
                await rec.may_serve_listing(mount, "/gh/d1", stored.version)
                is False
            )
        kept = await mount.index_store.list_dir("/gh/d1")
        assert kept.entries == stored.entries
        assert "listing check failed" in caplog.text
    finally:
        await ws.close()


def _row_stays_missing(store, key: str) -> None:
    get = store.get

    async def missing(path):
        result = await get(path)
        return (
            LookupResult(status=LookupStatus.NOT_FOUND)
            if (path == key)
            else result
        )

    store.get = missing


# A listed child whose row is still missing after the eviction refill is
# absent, as it was before rows were checked: one refill per command, and
# the retry inside the same stat does not refill again.
@pytest.mark.asyncio
async def test_a_row_missing_after_its_refill_costs_one_refill():
    store = RAMIndexCacheStore()
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub), index=store)) as ws:
            await _out(ws, "ls /gh")
            _row_stays_missing(store, "/gh/d1/a.txt")
            for command in (1, 2):
                hub.log.clear()
                result = await ws.shell("stat /gh/d1/a.txt")
                assert result.exit_code == 1
                assert "No such file" in await result.stderr_str()
                assert hub.count("recursive") == 1, command


# A truncated tree lists a folder by its path at the ref, so one first
# listed after the repository moved shows what the move added: the sha an
# older listing of its parent carries would not.
@pytest.mark.asyncio
async def test_a_truncated_folder_lists_at_the_ref_not_a_parents_sha():
    with serve(_three()) as hub:
        hub.truncated_recursive = True
        async with _open(_ws(_vfs(hub), policy=ReadPolicy.BOUNDED)) as ws:
            await _out(ws, "ls /gh")
            hub.files["d1/new.txt"] = b"new\n"
            assert await _out(ws, "ls /gh/d1") == GROWN


# The truncated arm re-lists the folder once per command, not twice.
@pytest.mark.asyncio
async def test_a_row_missing_after_its_relist_relists_once():
    store = RAMIndexCacheStore()
    with serve(_three()) as hub:
        hub.truncated_recursive = True
        async with _open(
            _ws(_vfs(hub), policy=ReadPolicy.BOUNDED, index=store)
        ) as ws:
            assert await _out(ws, "ls /gh/d1") == LISTED
            _row_stays_missing(store, "/gh/d1/a.txt")
            for command in (1, 2):
                hub.log.clear()
                result = await ws.shell("stat /gh/d1/a.txt")
                assert result.exit_code == 1
                assert hub.count("recursive") == 0
                assert hub.count("dir") == 1, command


# A warm tree walk reads the root listing once: the version the liveness
# probe read is the one the in-memory tree is matched against, and the
# root stat find and du make reads nothing.
@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["find /gh", "du -a /gh"])
async def test_a_warm_tree_walk_reads_the_root_listing_once(monkeypatch, line):
    with serve(_three()) as hub:
        async with _open(_ws(_vfs(hub), policy=ReadPolicy.BOUNDED)) as ws:
            await _out(ws, "ls -R /gh")
            await _out(ws, line)
            reads = _count_list_dirs(monkeypatch, ws.mount("/gh").index_store)
            hub.log.clear()
            await _out(ws, line)
            assert reads.count("/gh") == 1
            assert hub.counts() == (0, 0, 0)
