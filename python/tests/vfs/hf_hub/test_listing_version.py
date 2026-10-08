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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from fakeredis.aioredis import FakeRedis

from mirage.cache.index import LookupResult, LookupStatus
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.ram import ListingCheckStore, RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.core.api.client import RetryPolicy
from mirage.core.hf_hub.stat import stat
from mirage.types import (
    FileType,
    MountMode,
    PathSpec,
    ReadPolicy,
    ReadSpec,
)
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.reconcile import Reconciler
from tests.fixtures.hf_hub_api import FakeHub, serve

REPO = ("models", "acme/widget")
ROOT = PathSpec(virtual="/m", directory="/m", vfs_path="")
LISTED = b"b.txt\n"
GROWN = b"b.txt\nnew.txt\n"


def _hub() -> FakeHub:
    return FakeHub(
        repos={REPO: {"a.txt": b"alpha\n", "docs/sub/b.txt": b"bravo\n"}}
    )


def _vfs(hub: FakeHub, revision: str | None = None):
    config = {"repo_id": "acme/widget", "endpoint": hub.url}
    if revision is not None:
        config["revision"] = revision
    return build_vfs("hf_models", config)


def _ws(vfs, index=None) -> Workspace:
    ws = Workspace(
        {
            "/m": Mount(
                vfs=vfs,
                mode=MountMode.READ,
                read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
            ),
            "/r": (RAMVFS(), MountMode.WRITE),
        }
    )
    if index is not None:
        ws.mount("/m").index_store = index
    return ws


@asynccontextmanager
async def _open(vfs, index=None) -> AsyncIterator[Workspace]:
    ws = _ws(vfs, index)
    try:
        yield ws
    finally:
        await ws.close()


@asynccontextmanager
async def _served(
    make=_vfs, index=None
) -> AsyncIterator[tuple[FakeHub, Workspace]]:
    with serve(_hub()) as hub:
        async with _open(make(hub), index) as ws:
            yield hub, ws


async def _out(ws: Workspace, line: str) -> bytes:
    result = await asyncio.wait_for(ws.shell(line), 10)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


def _counts(hub: FakeHub) -> tuple[int, int, int, int]:
    return (
        hub.count("revision"),
        hub.count("tree"),
        hub.count("paths_info"),
        hub.count("resolve"),
    )


def _revs(hub: FakeHub, route: str) -> set[str]:
    return {rev for name, _, rev, _ in hub.log if name == route}


def _add(hub: FakeHub) -> None:
    hub.repos[REPO]["docs/sub/new.txt"] = b"new\n"


async def _stored(ws: Workspace, key: str = "/m") -> str | None:
    return (await ws.mount("/m").index_store.list_dir(key)).version


def _at_head(hub: FakeHub):
    return _vfs(hub, revision=hub.head(REPO))


# Named counts (revision, tree, paths_info, resolve).
@pytest.mark.asyncio
async def test_an_unchanged_second_command_costs_one_revision():
    async with _served() as (hub, ws):
        await _out(ws, "ls /m")
        hub.log.clear()
        assert await _out(ws, "ls /m/docs/sub") == LISTED
        assert _counts(hub) == (1, 0, 0, 0)


# The gate's check misses, and the refill asks the head once more for the
# commit it walks the tree at.
@pytest.mark.asyncio
async def test_a_changed_second_command_checks_then_walks_once():
    async with _served() as (hub, ws):
        await _out(ws, "ls /m")
        _add(hub)
        hub.log.clear()
        assert await _out(ws, "ls /m/docs/sub") == GROWN
        assert _counts(hub) == (2, 1, 0, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["find /m -type f", "ls -R /m"])
async def test_a_walk_after_an_outside_add_sees_it(line):
    async with _served() as (hub, ws):
        await _out(ws, "ls /m")
        hub.log.clear()
        assert b"new.txt" not in await _out(ws, line)
        assert _counts(hub) == (1, 0, 0, 0)
        _add(hub)
        hub.log.clear()
        assert b"new.txt" in await _out(ws, line)
        assert _counts(hub) == (2, 1, 0, 0)


# Repeated root stats on a mount that has not listed send nothing, and a
# fresh one's cold root stat sends nothing either: only the gate's check
# store asks the head.
@pytest.mark.asyncio
async def test_a_cold_root_stat_sends_no_request():
    async with _served() as (hub, ws):
        for _ in range(5):
            assert (await ws.stat("/m")).type == FileType.DIRECTORY
        assert await _out(ws, "stat -c %n /m") == b"/m\n"
        assert _counts(hub) == (0, 0, 0, 0)


# A second mount over a warm shared store has not loaded its tree; the
# gate's root stat, through its check store, asks the head once and never
# walks or loads the tree.
@pytest.mark.asyncio
async def test_a_root_stat_through_a_throwaway_index_never_walks():
    shared = RAMIndexCacheStore()
    with serve(_hub()) as hub:
        two_vfs = _vfs(hub)
        async with (
            _open(_vfs(hub), shared) as one,
            _open(two_vfs, shared) as two,
        ):
            await _out(one, "ls /m")
            hub.log.clear()
            found = await two.mount("/m").call(
                "stat", "/m", index=ListingCheckStore()
            )
            assert found.fingerprint == hub.head(REPO)
            assert _counts(hub) == (1, 0, 0, 0)
            assert two_vfs.accessor.tree_loaded is False


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
async def test_a_root_stat_through_the_mount_index_names_no_version(
    monkeypatch,
):
    now = [100.0]
    monkeypatch.setattr("mirage.cache.manager._now", lambda: now[0])
    async with _served() as (hub, ws):
        await _out(ws, "ls /m")
        stored = await _stored(ws)
        now[0] += LISTING_TRUST_WINDOW * 2
        hub.log.clear()
        mount = ws.mount("/m")
        reads = _count_list_dirs(monkeypatch, mount.index_store)
        async with command_scope():
            found = await stat(mount.vfs.accessor, ROOT, mount.index)
        assert stored is not None
        assert found.fingerprint is None
        assert reads == []
        assert _counts(hub) == (0, 0, 0, 0)


# A refused head names no version, and the root stat never falls into a
# refill of the throwaway index.
@pytest.mark.asyncio
@pytest.mark.parametrize("refusal", [(404, "RevisionNotFound"), (401, "")])
async def test_a_refused_head_names_no_version_and_walks_nothing(refusal):
    async with _served() as (hub, ws):
        await _out(ws, "ls /m")
        hub.fail["revision"] = refusal
        hub.log.clear()
        found = await stat(
            ws.mount("/m").vfs.accessor, ROOT, ListingCheckStore()
        )
        assert found.fingerprint is None
        assert (hub.count("revision"), hub.count("tree")) == (1, 0)


# A mount at an older commit's revision, over a store a `main` mount
# filled, must not serve main's listing.
@pytest.mark.asyncio
async def test_an_older_commit_revision_never_serves_another_revisions_listing():
    with serve(_hub()) as hub:
        old = hub.head(REPO)
        shared = RAMIndexCacheStore()
        async with _open(_vfs(hub), shared) as main:
            await _out(main, "ls /m/docs/sub")
            _add(hub)
            assert await _out(main, "ls /m/docs/sub") == GROWN
        async with _open(_vfs(hub, revision=old), shared) as older:
            hub.log.clear()
            assert await _out(older, "ls /m/docs/sub") == LISTED
            assert _counts(hub) == (2, 1, 0, 0)
            hub.log.clear()
            assert await _out(older, "ls /m/docs/sub") == LISTED
            assert _counts(hub) == (1, 0, 0, 0)


# An hf mount checks its head every command, even at a full-sha revision:
# nothing it can learn once says the name will keep resolving to that
# commit, so a branch named like it, made after the mount listed, is seen
# on the next command.
@pytest.mark.asyncio
async def test_a_full_sha_revision_checks_its_head_every_command():
    async with _served(_at_head) as (hub, ws):
        name = hub.head(REPO)
        assert await _out(ws, "ls /m/docs/sub") == LISTED
        assert await _stored(ws) == name
        hub.log.clear()
        assert await _out(ws, "ls /m/docs/sub") == LISTED
        assert _counts(hub) == (1, 0, 0, 0)
        _add(hub)
        hub.branches.add(name)
        hub.log.clear()
        assert await _out(ws, "ls /m/docs/sub") == GROWN
        assert _counts(hub) == (2, 1, 0, 0)


# A commit landing between the head and the tree walk: the tree is walked
# at the head that was named, so the rows match their version, and the
# next command's check sees the change.
@pytest.mark.asyncio
async def test_a_commit_between_the_head_and_the_walk_is_caught_next_command():
    async with _served() as (hub, ws):
        old = hub.head(REPO)
        hub.after_revision = lambda: _add(hub)
        assert await _out(ws, "ls /m/docs/sub") == LISTED
        hub.after_revision = None
        assert _revs(hub, "tree") == {old}
        assert await _stored(ws) == old
        hub.log.clear()
        assert await _out(ws, "ls /m/docs/sub") == GROWN
        assert _counts(hub) == (2, 1, 0, 0)


# A revision the Hub does not know: the refusal wording is the one the
# tree walk gave before the head was asked first.
@pytest.mark.asyncio
async def test_a_bad_revision_reads_as_permission_denied():
    async with _served(lambda hub: _vfs(hub, revision="f" * 40)) as (_, ws):
        ls = await ws.shell("ls /m")
        assert (ls.exit_code, await ls.stderr_str()) == (
            2,
            "ls: cannot open directory '/m': Permission denied\n",
        )
        cat = await ws.shell("cat /m/a.txt")
        assert (cat.exit_code, await cat.stderr_str()) == (
            1,
            "cat: /m/a.txt: Permission denied\n",
        )
        assert await _out(ws, "stat -c %n /m") == b"/m\n"


# On Redis a versioned listing is served on the version alone, nested
# folders included: the store does not check the children's rows.
@pytest.mark.asyncio
async def test_an_unchanged_listing_on_redis_costs_one_revision():
    client = FakeRedis()
    try:
        async with _served(index=RedisIndexCacheStore(client=client)) as (
            hub,
            ws,
        ):
            await _out(ws, "ls /m")
            hub.log.clear()
            assert await _out(ws, "ls /m /m/docs /m/docs/sub") == (
                b"/m:\na.txt\ndocs\n\n/m/docs:\nsub\n\n/m/docs/sub:\nb.txt\n"
            )
            assert _counts(hub) == (1, 0, 0, 0)
    finally:
        await client.aclose()


def _store(backend: str):
    client = FakeRedis() if backend == "redis" else None
    if client is None:
        return RAMIndexCacheStore(), None
    return RedisIndexCacheStore(client=client), client


async def _drop_row(store, client, key: str) -> None:
    if client is None:
        await store.invalidate_entry(key)
    else:
        await client.delete(store._entry_key(key))


# Eviction can drop a child's row while its listing survives. The store
# still serves the listing; a stat or read of the listed child finds no
# row and refills once, so it answers the child rather than a hole.
@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_a_listed_child_without_a_row_refills_once(backend):
    store, client = _store(backend)
    try:
        async with _served(index=store) as (hub, ws):
            await _out(ws, "ls /m")
            await _drop_row(store, client, "/m/docs/sub/b.txt")
            hub.log.clear()
            assert await _out(ws, "cat /m/docs/sub/b.txt") == b"bravo\n"
            assert hub.count("tree") == 1
            assert await _out(ws, "stat -c %n /m/docs/sub/b.txt") == (
                b"/m/docs/sub/b.txt\n"
            )
            assert await _out(ws, "ls /m/docs/sub") == LISTED
            assert hub.count("tree") == 1
    finally:
        if client is not None:
            await client.aclose()


# A name the live listing does not hold is absent, and costs no refill.
@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_an_unlisted_name_is_absent_without_a_refill(backend):
    store, client = _store(backend)
    try:
        async with _served(index=store) as (hub, ws):
            await _out(ws, "ls /m")
            hub.log.clear()
            result = await ws.shell("stat /m/docs/sub/zz.txt")
            assert result.exit_code == 1
            assert "No such file" in await result.stderr_str()
            assert hub.count("tree") == 0
    finally:
        if client is not None:
            await client.aclose()


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
# absent, as it was before rows were checked: one refill per command. The
# refill bumps the accessor's refill count, which used to send the retry
# into a second refill of its own.
@pytest.mark.asyncio
async def test_a_row_missing_after_its_refill_costs_one_refill():
    store = RAMIndexCacheStore()
    async with _served(index=store) as (hub, ws):
        await _out(ws, "ls /m")
        _row_stays_missing(store, "/m/docs/sub/b.txt")
        for command in (1, 2):
            hub.log.clear()
            result = await ws.shell("stat /m/docs/sub/b.txt")
            assert result.exit_code == 1
            assert "No such file" in await result.stderr_str()
            assert hub.count("tree") == 1, command


def _prefixed(hub: FakeHub, key_prefix: str | None, revision: str | None):
    config = {"repo_id": "acme/widget", "endpoint": hub.url}
    if key_prefix is not None:
        config["key_prefix"] = key_prefix
    if revision is not None:
        config["revision"] = revision
    return build_vfs("hf_models", config)


# Index keys are mount-relative, so two mounts of one repository with
# different key prefixes over one shared store must not share a version:
# the second mount's check would match, and it would serve the first one's
# subtree as its own root.
@pytest.mark.asyncio
@pytest.mark.parametrize("full_sha", [False, True])
async def test_a_key_prefix_keeps_shared_listings_apart(full_sha):
    shared = RAMIndexCacheStore()
    with serve(_hub()) as hub:
        revision = hub.head(REPO) if full_sha else None
        async with (
            _open(_prefixed(hub, "docs/", revision), shared) as sub,
            _open(_prefixed(hub, None, revision), shared) as whole,
        ):
            assert await _out(sub, "ls /m") == b"sub\n"
            assert await _out(whole, "ls /m") == b"a.txt\ndocs\n"
            assert await _out(sub, "ls /m") == b"sub\n"
            assert await _out(whole, "ls /m/docs/sub") == LISTED


# The composed version is what the root stat names, so the gate's check
# still matches what a prefixed mount's fill stored, and a mount with no
# key prefix keeps the plain head.
@pytest.mark.asyncio
async def test_a_prefixed_mount_checks_the_version_it_stored():
    with serve(_hub()) as hub:
        async with _open(_prefixed(hub, "docs/", None)) as ws:
            await _out(ws, "ls /m")
            stored = await _stored(ws)
            assert stored is not None and stored != hub.head(REPO)
            hub.log.clear()
            assert await _out(ws, "ls /m") == b"sub\n"
            assert _counts(hub) == (1, 0, 0, 0)
        async with _open(_prefixed(hub, None, None)) as plain:
            await _out(plain, "ls /m")
            assert await _stored(plain) == hub.head(REPO)


# A Hub that cannot be reached answers EXPIRED at the gate, logged, and the
# listing stays stored for the re-list to diff.
@pytest.mark.asyncio
async def test_an_unreachable_hub_keeps_the_listing(caplog, monkeypatch):
    monkeypatch.setattr(
        "mirage.core.hf_hub.client.RETRY", RetryPolicy(retry_transport=False)
    )
    caplog.set_level(logging.DEBUG, logger="mirage.workspace.reconcile")
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        await _out(ws, "ls /m")
    try:
        mount = ws.mount("/m")
        stored = await mount.index_store.list_dir("/m/docs/sub")
        rec = Reconciler(ws.cache, ws.namespace)
        async with command_scope():
            assert (
                await rec.may_serve_listing(
                    mount, "/m/docs/sub", stored.version
                )
                is False
            )
        kept = await mount.index_store.list_dir("/m/docs/sub")
        assert kept.entries == stored.entries
        assert "listing check failed" in caplog.text
    finally:
        await ws.close()


# A FUSE or programmatic read belongs to no command: it trusts a listing
# for the window, then pays one version check, never a tree walk.
@pytest.mark.asyncio
async def test_an_unscoped_read_checks_once_past_the_window(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("mirage.cache.manager._now", lambda: now[0])
    readdir = PathSpec(
        virtual="/m/docs/sub", directory="/m/docs/sub", vfs_path="docs/sub"
    )
    one = PathSpec(
        virtual="/m/docs/sub/b.txt",
        directory="/m/docs/sub",
        vfs_path="docs/sub/b.txt",
    )
    async with _served() as (hub, ws):
        await _out(ws, "ls /m")
        hub.log.clear()
        listed, _ = await ws.dispatch("readdir", readdir)
        assert listed == ["/m/docs/sub/b.txt"]
        await ws.dispatch("stat", one)
        assert _counts(hub) == (0, 0, 0, 0)
        now[0] += LISTING_TRUST_WINDOW
        await ws.dispatch("readdir", readdir)
        await ws.dispatch("stat", one)
        assert _counts(hub) == (1, 0, 0, 0)
