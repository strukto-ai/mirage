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
import errno
import logging
import os
from contextlib import asynccontextmanager
from unittest.mock import patch
from uuid import uuid4

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index.config import (
    Evicted,
    IndexConfig,
    IndexEntry,
    RedisIndexConfig,
)
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.ram import ListingCheckStore, RAMIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.errors.fs import enotsup
from mirage.types import FileStat, FileType, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace.mount.namespace.namespace import NodeMeta
from mirage.workspace.reconcile import Reconciler
from tests.e2e.s3_mock import patch_s3_multi
from tests.fixtures.versioned_vfs import (
    StatlessVersionedVFS,
    VersionedVFS,
)


async def _ws_with_overlay():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/f.txt", mode=0o600)
    return ws


@pytest.mark.asyncio
async def test_on_missing_evicts_and_gcs_overlay():
    ws = await _ws_with_overlay()
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_missing("/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_on_missing_keeps_symlink():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.symlink("/data/link", "/data/t", 1.0)
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_missing("/data/link")
    assert ws.namespace.readlink("/data/link") == "/data/t"


@pytest.mark.asyncio
async def test_on_gone_for_a_file_evicts_its_bytes_and_overlay():
    ws = await _ws_with_overlay()
    await ws.cache.set("/data/f.txt", b"v1")
    await ws.cache.set("/data/f.txt.bak", b"keep")
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_gone([Evicted("/data/f.txt", folder=False)])
    assert ws.namespace.meta_for("/data/f.txt") is None
    assert not await ws.cache.exists("/data/f.txt")
    assert await ws.cache.exists("/data/f.txt.bak")


@pytest.mark.asyncio
async def test_on_gone_for_a_folder_takes_its_subtree_but_not_links():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/sub", mode=0o700)
    await ws.namespace.set_attrs("/data/sub/x", mode=0o600)
    await ws.namespace.set_attrs("/data/sub2/x", mode=0o600)
    await ws.namespace.symlink("/data/sub/link", "/data/t", 1.0)
    await ws.cache.set("/data/sub/x", b"x")
    await ws.cache.set("/data/sub2/x", b"keep")
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_gone([Evicted("/data/sub", folder=True)])
    assert ws.namespace.meta_for("/data/sub") is None
    assert ws.namespace.meta_for("/data/sub/x") is None
    assert ws.namespace.readlink("/data/sub/link") == "/data/t"
    assert ws.namespace.meta_for("/data/sub2/x") is not None
    assert not await ws.cache.exists("/data/sub/x")
    assert await ws.cache.exists("/data/sub2/x")


@pytest.mark.asyncio
async def test_on_op_missing_skips_under_bounded():
    """A mount that declined to revalidate also declines to GC on a miss.

    Not merely a cost choice: an ENOENT here is not proof the backend
    said so, because object-store ``stat`` and several reads answer a
    miss straight out of a live index. Reacting would drop an attribute
    overlay nothing can restore.
    """
    ws = await _ws_with_overlay()
    mount = ws.namespace.mount_for("/data/f.txt")
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_enoent(mount, "stat", "/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is not None


@pytest.mark.asyncio
async def test_on_op_missing_skips_non_revalidate_op():
    ws = await _ws_with_overlay()
    mount = ws.namespace.mount_for("/data/f.txt")
    mount.read = ReadSpec(policy=ReadPolicy.FRESH)
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_enoent(mount, "write", "/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is not None


@pytest.mark.asyncio
async def test_on_op_missing_gcs_on_a_fresh_mounts_stat():
    ws = await _ws_with_overlay()
    mount = ws.namespace.mount_for("/data/f.txt")
    mount.read = ReadSpec(policy=ReadPolicy.FRESH)
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.on_enoent(mount, "stat", "/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_may_serve_listing_trusts_the_index_under_bounded():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    mount = ws.namespace.mount_for("/data/d")
    rec = Reconciler(ws.cache, ws.namespace)
    assert await rec.may_serve_listing(mount, "/data/d", None) is True
    await ws.close()


@pytest.mark.asyncio
async def test_may_serve_listing_under_fresh_trusts_only_this_commands_writes(
    monkeypatch,
):
    # fresh re-lists anything listed before the command started; a listing
    # the command itself refreshed is served, so one ls costs one re-list.
    # Outside any command a listing is trusted only for the window.
    now = [100.0]
    monkeypatch.setattr("mirage.cache.manager._now", lambda: now[0])
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    mount = ws.namespace.mount_for("/data/d")
    mount.read = ReadSpec(policy=ReadPolicy.FRESH)
    rec = Reconciler(ws.cache, ws.namespace)
    await mount.index.set_dir("/data/d", [])
    assert await rec.may_serve_listing(mount, "/data/d", None) is True
    now[0] += LISTING_TRUST_WINDOW
    assert await rec.may_serve_listing(mount, "/data/d", None) is False
    async with command_scope():
        assert await rec.may_serve_listing(mount, "/data/d", None) is False
        await mount.index.set_dir("/data/d", [])
        assert await rec.may_serve_listing(mount, "/data/d", None) is True
        assert await rec.may_serve_listing(mount, "/data/other", None) is False
    await ws.close()


@pytest.mark.asyncio
async def test_may_serve_cached_trusts_cache_under_bounded():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/f.txt")
    rec = Reconciler(ws.cache, ws.namespace)
    assert await rec.may_serve_cached(mount, "/data/f.txt") is True


@pytest.mark.asyncio
async def test_may_serve_cached_no_fingerprint_forces_reread():
    """A stat that carries no content token cannot verify the copy.

    The path exists and is cached, so the only reason to refuse is the
    verdict: RAM stats without a fingerprint, which is UNKNOWN, which
    evicts. This used to be answered by a ``supports_snapshot``
    short-circuit that never probed at all.
    """
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        stat = await mount.call("stat", "/data/f.txt")
        assert stat is not None and stat.fingerprint is None
        rec = Reconciler(ws.cache, ws.namespace)
        assert await rec.may_serve_cached(mount, "/data/f.txt") is False
        assert not await ws.cache.exists("/data/f.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_may_serve_cached_serves_a_fingerprinted_live_only_backend():
    """A live-only backend that DOES stamp a fingerprint keeps its cache.

    ``supports_snapshot`` is about whether a mount can be snapshotted, not
    about whether its stat carries a content token; box, dropbox, github,
    ssh and dify stamp one without setting the flag. Reading the flag here
    threw their verified entries away.
    """
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)
        assert mount.vfs.supports_snapshot is False
        real = mount.call

        async def fingerprinted(op, path, **kwargs):
            stat = await real(op, path, **kwargs)
            return (
                stat.model_copy(update={"fingerprint": "fp1"})
                if op == "stat" and stat is not None
                else stat
            )

        mount.call = fingerprinted
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace)
        assert await rec.may_serve_cached(mount, "/data/f.txt") is True
        assert await ws.cache.exists("/data/f.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_reconcile_read_gcs_orphan_on_delete():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    mount = ws.namespace.mount_for("/data/gone.txt")
    mount.read = ReadSpec(policy=ReadPolicy.FRESH)
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.reconcile_read(mount, "/data/gone.txt")
    assert ws.namespace.meta_for("/data/gone.txt") is None


@pytest.mark.asyncio
async def test_reconcile_read_noop_without_overlay_or_cache():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/plain.txt")
    mount.read = ReadSpec(policy=ReadPolicy.FRESH)
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.reconcile_read(mount, "/data/plain.txt")


@pytest.mark.asyncio
async def test_reconcile_read_skips_under_bounded():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    mount = ws.namespace.mount_for("/data/gone.txt")
    rec = Reconciler(ws.cache, ws.namespace)
    await rec.reconcile_read(mount, "/data/gone.txt")
    assert ws.namespace.meta_for("/data/gone.txt") is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["no_stat_op", "flaky"])
async def test_an_unverifiable_probe_drops_the_entry(caplog, failure):
    """Both ways of failing to verify end at UNKNOWN; only one is logged.

    A backend with no stat op and a backend whose stat is throwing reach
    the same verdict -- drop the entry, read cold -- and that is the whole
    behavioural contract. What separates them is the log: a missing op is
    a permanent capability of the mount, so warning on every read would be
    noise, while a throwing stat is an anomaly worth surfacing. Asserting
    the log is what keeps the carve-out from being dead weight.
    """
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)

        async def failing(op, path, **_kwargs):
            if failure == "no_stat_op":
                raise enotsup("stubborn", op, path)
            raise OSError(errno.EIO, "backend stat unavailable")

        mount.call = failing
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace)
        with caplog.at_level(
            logging.WARNING, logger="mirage.workspace.reconcile"
        ):
            assert await rec.may_serve_cached(mount, "/data/f.txt") is False
        assert not await ws.cache.exists("/data/f.txt")
        # The capture collects every logger, so filter to ours first.
        ours = [
            r for r in caplog.records if r.name == "mirage.workspace.reconcile"
        ]
        assert bool(ours) is (failure == "flaky")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("index_type", ["ram", "redis"])
@pytest.mark.parametrize("surface", ["shell", "fs"])
@pytest.mark.parametrize("change", ["overwrite", "delete"])
async def test_always_probes_live_s3_with_warm_index(
    index_type, surface, change
):
    index = None
    if index_type == "redis":
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        index = RedisIndexConfig(url=url, key_prefix=f"reconcile:{uuid4()}:")
    objects = {"f.txt": b"v1"}
    vfs = S3VFS(
        S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
    )
    with patch_s3_multi({"test-bucket": objects}):
        ws = Workspace(
            {"/s3": vfs}, index=index, read=ReadSpec(policy=ReadPolicy.FRESH)
        )
        store = ws.mount("/s3").index_store
        try:
            assert (await ws.shell("ls /s3/")).exit_code == 0
            assert (await store.get("/s3/f.txt")).entry is not None
            assert (await ws.shell("cat /s3/f.txt")).stdout == b"v1"
            assert await ws.cache.exists("/s3/f.txt")
            if change == "overwrite":
                objects["f.txt"] = b"v2"
            else:
                del objects["f.txt"]
            if surface == "shell":
                result = await ws.shell("cat /s3/f.txt")
                assert result.stdout == (
                    b"v2" if change == "overwrite" else b""
                )
                assert result.exit_code == (0 if change == "overwrite" else 1)
            elif change == "overwrite":
                assert await ws.vfs.read("/s3/f.txt") == b"v2"
            else:
                with pytest.raises(FileNotFoundError):
                    await ws.vfs.read("/s3/f.txt")
        finally:
            await store.clear()
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("probe", ["unknown", "none", "failed", "fresh"])
@pytest.mark.parametrize("surface", ["shell", "gate"])
async def test_unverified_probe_cannot_serve_cached_bytes(
    monkeypatch, probe, surface
):
    ws = Workspace({"/data": RAMVFS()})
    try:
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)
        monkeypatch.setattr(mount.vfs, "supports_snapshot", True)
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")

        async def stat(*args, **kwargs):
            if probe == "failed":
                raise OSError("probe unavailable")
            if probe == "none":
                return None
            return FileStat(
                name="f.txt",
                type=FileType.FILE,
                fingerprint="fp1" if probe == "fresh" else None,
            )

        monkeypatch.setattr(mount, "call", stat)
        rec = Reconciler(ws.cache, ws.namespace)
        if surface == "shell":
            # Routing-time reconcile drops what it could not verify and
            # lets the command run: it serves no bytes itself, and raising
            # from here would abort the whole line. The gate is where a
            # failed probe refuses -- the "gate" surface below.
            await rec.reconcile_read(mount, "/data/f.txt")
            assert await ws.cache.exists("/data/f.txt") == (probe == "fresh")
        elif probe == "failed":
            # A probe that cannot run is "cannot verify", not a refusal:
            # the entry is dropped and the caller reads cold, so one
            # flaky stat costs a refetch rather than the whole command.
            assert await rec.may_serve_cached(mount, "/data/f.txt") is False
            assert not await ws.cache.exists("/data/f.txt")
        else:
            assert await rec.may_serve_cached(mount, "/data/f.txt") == (
                probe == "fresh"
            )
            assert await ws.cache.exists("/data/f.txt") == (probe == "fresh")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["bug", "flaky"])
async def test_reconcile_read_never_raises_and_drops_the_entry(failure):
    """Routing runs before any handler exists, so nothing may escape.

    A raise here does not fail one command; it takes the whole line,
    later pipeline stages and ``;`` chains included, and reports itself
    with no operand to name. So every failure is absorbed -- including
    the programming-error classes the gate is allowed to re-raise -- and
    whatever could not be verified is dropped, the same reaction the
    flaky arm already has. Keeping the entry would let a metadata command
    serve a stale size from it with no check at all.
    """
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)

        async def failing(*_args, **_kwargs):
            if failure == "bug":
                raise TypeError("probe bug")
            raise OSError(errno.EIO, "backend stat unavailable")

        mount.call = failing
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace)
        await rec.reconcile_read(mount, "/data/f.txt")
        assert not await ws.cache.exists("/data/f.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_bounded_removes_a_bound_less_entry_and_the_refill_stamps():
    """The self-heal must remove, not merely decline to serve.

    RAM stamps no fingerprint on a read record, so this is the case the
    removal exists for: leave the entry in place and the cold read that
    follows hits `_set_cached_locked`'s warm-read short-circuit
    (`fingerprint is None and cache.get(path) == data`), returns without
    re-setting, and the path refetches on every read forever. Deleting
    the `remove` call makes the second assertion fail.
    """
    resource = RAMVFS()
    resource.caches_reads = True
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        # An entry as a pre-D1 deployment left it: bytes, no bound.
        await ws.cache.set("/data/f.txt", b"v1")
        assert await ws.cache.is_unbounded("/data/f.txt") is True

        mount = ws.namespace.mount_for("/data/f.txt")
        rec = Reconciler(ws.cache, ws.namespace)
        assert await rec.may_serve_cached(mount, "/data/f.txt") is False
        assert not await ws.cache.exists("/data/f.txt"), (
            "the bound-less entry must be removed, not just refused"
        )

        assert (await ws.shell("cat /data/f.txt")).stdout == b"v1"
        assert await ws.cache.is_unbounded("/data/f.txt") is False, (
            "the cold read must re-stamp the bound, or the drop repeats "
            "on every read forever"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_bounded_serves_an_entry_that_carries_a_bound():
    """The other half: a properly stamped entry is served untouched."""
    resource = RAMVFS()
    resource.caches_reads = True
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        await ws.cache.set("/data/f.txt", b"v1", ttl=600)
        mount = ws.namespace.mount_for("/data/f.txt")
        rec = Reconciler(ws.cache, ws.namespace)
        assert await rec.may_serve_cached(mount, "/data/f.txt") is True
        assert await ws.cache.exists("/data/f.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fresh_s3_relist_keeps_deletion_baseline_after_stat():
    objects = {"sub/a": b"a", "sub/b": b"b"}
    vfs = S3VFS(
        S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
    )
    with patch_s3_multi({"test-bucket": objects}):
        ws = Workspace({"/s3": vfs}, read=ReadSpec(policy=ReadPolicy.FRESH))
        try:
            for command in ("ls /s3/sub", "cat /s3/sub/a", "ls /s3"):
                assert (await ws.shell(command)).exit_code == 0
            await ws.namespace.set_attrs("/s3/sub/a", mode=0o600)
            assert await ws.cache.exists("/s3/sub/a")
            del objects["sub/a"]
            result = await ws.shell("ls /s3/sub")
            assert result.stdout == b"b\n"
            assert not await ws.cache.exists("/s3/sub/a")
            assert ws.namespace.meta_for("/s3/sub/a") is None
        finally:
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("shared", [False, True])
@pytest.mark.parametrize("redis", [False, True])
@pytest.mark.parametrize("replacement", [False, True])
async def test_relist_preserves_nested_mount_subtree(
    shared, redis, replacement
):
    config = IndexConfig(ttl=600)
    if redis:
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        config = RedisIndexConfig(url=url, key_prefix=f"nested:{uuid4()}:")
    parent = RAMVFS()
    ws = Workspace(
        {"/data": parent, "/data/sub/nested": parent if shared else RAMVFS()},
        index=config,
    )
    try:
        await ws.namespace.ensure_loaded()
        index = ws.mount("/data").index
        nested = ws.mount("/data/sub/nested").index
        await index.set_dir(
            "/data",
            [
                (
                    "sub",
                    IndexEntry(id="sub", name="sub", resource_type="folder"),
                )
            ],
        )
        await nested.set_dir(
            "/data/sub/nested",
            [
                (
                    "file",
                    IndexEntry(id="file", name="file", resource_type="file"),
                )
            ],
        )
        await ws.cache.set("/data/sub/old", b"old")
        await ws.cache.set("/data/sub/nested/file", b"keep")
        await ws.namespace.set_attrs("/data/sub/old", mode=0o600)
        await ws.namespace.set_attrs("/data/sub/nested/file", mode=0o640)
        rows = []
        if replacement:
            rows.append(
                ("sub", IndexEntry(id="new", name="sub", resource_type="file"))
            )
        await index.set_dir("/data", rows)
        if replacement:
            assert (await index.get("/data/sub")).entry.id == "new"
        assert await ws.cache.get("/data/sub/nested/file") == b"keep"
        assert ws.namespace.meta_for("/data/sub/nested/file").mode == 0o640
        assert (await nested.list_dir("/data/sub/nested")).entries == [
            "/data/sub/nested/file"
        ]
        assert (await nested.get("/data/sub/nested/file")).entry is not None
        assert not await ws.cache.exists("/data/sub/old")
        assert ws.namespace.meta_for("/data/sub/old") is None
    finally:
        await ws.mount("/data").index_store.clear()
        await ws.mount("/data/sub/nested").index_store.clear()
        await ws.close()


class _CountedNodes(dict[str, NodeMeta]):
    scans = 0

    def items(self):
        self.scans += 1
        return super().items()


@pytest.mark.asyncio
async def test_relist_batches_a_thousand_vanished_children():
    ws = Workspace({"/data": RAMVFS()}, index=IndexConfig(ttl=600))
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.mount("/data")
        rows = [
            (
                f"file-{i}",
                IndexEntry(id=str(i), name=f"file-{i}", resource_type="file"),
            )
            for i in range(1000)
        ]
        await mount.index.set_dir("/data", rows)
        for name, _ in rows:
            await ws.cache.set(f"/data/{name}", b"stale")
            await ws.namespace.set_attrs(f"/data/{name}", mode=0o600)
        await ws.cache.set("/data/keeper", b"keep")
        await ws.namespace.set_attrs("/data/keeper", mode=0o640)
        nodes = _CountedNodes(ws.namespace.nodes)
        ws.namespace._nodes = nodes
        manager = mount.cache_manager
        assert manager is not None
        with patch.object(manager, "mutation", wraps=manager.mutation) as lock:
            await mount.index.set_dir("/data", [])
        assert lock.call_count == 1
        assert nodes.scans == 1
        assert set(nodes) == {"/data/keeper"}
        assert await ws.cache.get("/data/keeper") == b"keep"
        assert not await ws.cache.exists("/data/file-0")
        assert not await ws.cache.exists("/data/file-999")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cleanup_batches_overlapping_folders_and_protects_nested_mounts():
    ws = Workspace(
        {"/data": RAMVFS(), "/data/tree/nested": RAMVFS()},
        index=IndexConfig(ttl=600),
    )
    try:
        await ws.namespace.ensure_loaded()
        removed = ["/data/tree", "/data/tree/sub/old", "/data/tree2/old"]
        kept = ["/data/tree/nested/keep", "/data/treehouse/keep"]
        for path in removed + kept:
            await ws.cache.set(path, b"data")
            await ws.namespace.set_attrs(path, mode=0o600)
        await ws.namespace.symlink("/data/tree/link", "/data/target", 1)
        with patch.object(
            ws.cache, "evict_prefix", wraps=ws.cache.evict_prefix
        ) as evict:
            await ws.mount("/data").index.report_gone(
                [
                    Evicted("/data/tree/sub", folder=True),
                    Evicted("/data/tree/sub/old", folder=False),
                    Evicted("/data/tree/", folder=True),
                    Evicted("/data/tree", folder=True),
                    Evicted("/data/tree2", folder=True),
                    Evicted("/data/tree/nested/keep", folder=False),
                ]
            )
        assert evict.call_count == 2
        assert {call.args[0] for call in evict.call_args_list} == {
            "/data/tree/",
            "/data/tree2/",
        }
        for path in removed:
            assert not await ws.cache.exists(path)
            assert ws.namespace.meta_for(path) is None
        for path in kept:
            assert await ws.cache.exists(path)
            assert ws.namespace.meta_for(path) is not None
        assert ws.namespace.readlink("/data/tree/link") == "/data/target"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_write_in_the_command_sends_the_next_probe_to_the_backend():
    # The gate reuses what routing got from the backend; a write in the same
    # command retires that answer, so the next probe asks again and sees a
    # deletion the remembered stat would have hidden.
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace)
        spec = PathSpec.from_str_path("/data/f.txt")
        async with command_scope():
            await rec.reconcile_read(mount, "/data/f.txt")
            probed = mount.cache_manager.probed_stat(spec)
            assert probed is not None and probed.size == 2
            del resource._store.files["/f.txt"]
            await mount.cache_manager.invalidate_after_write(
                PathSpec.from_str_path("/data/g.txt")
            )
            await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
            with pytest.raises(FileNotFoundError):
                await rec.may_serve_cached(mount, "/data/f.txt")
    finally:
        await ws.close()


class _CountingStat:
    def __init__(self, fingerprint: str) -> None:
        self.fingerprint = fingerprint
        self.calls = 0

    async def __call__(self, op, path, **kwargs):
        self.calls += 1
        return FileStat(
            name="f.txt",
            size=2,
            type=FileType.FILE,
            fingerprint=self.fingerprint,
        )


async def _gated(fingerprint: str = "fp1"):
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/f.txt")
    mount.read = ReadSpec(policy=ReadPolicy.FRESH)
    stat = _CountingStat(fingerprint)
    mount.call = stat
    await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
    return ws, mount, stat, Reconciler(ws.cache, ws.namespace)


@pytest.mark.asyncio
async def test_the_gate_reuses_the_routing_probes_answer():
    # Routing and the gate share the command: the gate compares the cache
    # against what routing got from the backend instead of asking again.
    ws, mount, stat, rec = await _gated()
    try:
        async with command_scope():
            await rec.reconcile_read(mount, "/data/f.txt")
            assert await rec.may_serve_cached(mount, "/data/f.txt") is True
        assert stat.calls == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_write_during_a_probe_prevents_reusing_its_answer():
    ws, mount, stat, rec = await _gated()
    captured, release = asyncio.Event(), asyncio.Event()

    async def delayed(op, path, **kwargs):
        result = await stat(op, path, **kwargs)
        if not captured.is_set():
            captured.set()
            await release.wait()
        return result

    mount.call = delayed
    try:
        async with command_scope():
            probing = asyncio.create_task(
                rec.reconcile_read(mount, "/data/f.txt")
            )
            await captured.wait()
            await mount.cache_manager.invalidate_after_write(
                PathSpec.from_str_path("/data/g.txt")
            )
            stat.fingerprint = "fp2"
            release.set()
            await probing
            assert await rec.may_serve_cached(mount, "/data/f.txt") is False
            assert stat.calls == 2
    finally:
        release.set()
        await ws.close()


@pytest.mark.asyncio
async def test_the_gate_still_compares_a_reused_answer_with_the_cache():
    # Reuse skips the round trip, never the verdict: a remembered token that
    # does not match the cached copy still evicts it.
    ws, mount, stat, rec = await _gated()
    try:
        async with command_scope():
            mount.cache_manager.note_probed(
                PathSpec.from_str_path("/data/f.txt"),
                FileStat(
                    name="f.txt", size=2, type=FileType.FILE, fingerprint="fp2"
                ),
            )
            assert await rec.may_serve_cached(mount, "/data/f.txt") is False
        assert not await ws.cache.exists("/data/f.txt")
        assert stat.calls == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_gate_asks_the_backend_after_a_write_in_the_command():
    ws, mount, stat, rec = await _gated()
    try:
        async with command_scope():
            await rec.reconcile_read(mount, "/data/f.txt")
            await mount.cache_manager.invalidate_after_write(
                PathSpec.from_str_path("/data/g.txt")
            )
            await rec.may_serve_cached(mount, "/data/f.txt")
        assert stat.calls == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_gate_asks_the_backend_after_an_external_clear():
    # Native code (an external program, a remote runtime line) may have
    # changed the mount mid-command; the clear that follows it must retire
    # what routing saw, as a write in the command does.
    ws, mount, stat, rec = await _gated()
    try:
        async with command_scope():
            await rec.reconcile_read(mount, "/data/f.txt")
            await ws.namespace.registry.invalidate_after_external()
            await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
            await rec.may_serve_cached(mount, "/data/f.txt")
        assert stat.calls == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_gate_asks_the_backend_outside_a_command():
    # FUSE and the dispatcher belong to no command, so nothing a command's
    # probe saw is reused for them.
    ws, mount, stat, rec = await _gated()
    try:
        async with command_scope():
            await rec.reconcile_read(mount, "/data/f.txt")
        await rec.may_serve_cached(mount, "/data/f.txt")
        assert stat.calls == 2
    finally:
        await ws.close()


@asynccontextmanager
async def _versioned(
    kind: str = "mount",
    remote: str | None = "v1",
    *,
    has_stat: bool = True,
):
    vfs = (VersionedVFS if has_stat else StatlessVersionedVFS)(kind, remote)
    ws = Workspace({"/m/": vfs}, read=ReadSpec(policy=ReadPolicy.FRESH))
    mount = ws.namespace.mount_for("/m/a")
    try:
        yield vfs, mount, Reconciler(ws.cache, ws.namespace)
    finally:
        if vfs.hold is not None:
            vfs.hold.set()
        await ws.close()


async def _store(mount, folder: str, version: str | None) -> None:
    # The raw store, so the write is not one the running command made.
    await mount.index_store.set_dir(folder, [], version=version)


async def _sent(vfs: VersionedVFS) -> None:
    await asyncio.wait_for(vfs.sent.wait(), timeout=2)
    vfs.sent.clear()


@pytest.mark.asyncio
async def test_listing_gate_trusts_this_commands_own_listing_unchecked():
    async with _versioned() as (vfs, mount, rec):
        async with command_scope():
            await mount.index.set_dir("/m/a", [], version="v1")
            assert await rec.may_serve_listing(mount, "/m/a", "v1") is True
        assert vfs.stats == []


@pytest.mark.asyncio
async def test_listing_gate_never_checks_a_mount_without_versions():
    async with _versioned(kind="none") as (vfs, mount, rec):
        await _store(mount, "/m/a", "v1")
        async with command_scope():
            assert await rec.may_serve_listing(mount, "/m/a", "v1") is False
        assert vfs.stats == []


@pytest.mark.asyncio
async def test_listing_gate_never_checks_a_listing_stored_without_a_version():
    async with _versioned() as (vfs, mount, rec):
        await _store(mount, "/m/a", None)
        async with command_scope():
            assert await rec.may_serve_listing(mount, "/m/a", None) is False
        assert vfs.stats == []


@pytest.mark.asyncio
async def test_listing_gate_refuses_a_moved_version_and_keeps_the_listing():
    # A refusal leaves the listing stored for the re-list to diff, and the
    # index is never cleared.
    async with _versioned(remote="v2") as (vfs, mount, rec):
        await _store(mount, "/m/a", "v1")
        await mount.index_store.put(
            "/m/f.txt", IndexEntry(id="f", name="f.txt", resource_type="file")
        )
        async with command_scope():
            assert await rec.may_serve_listing(mount, "/m/a", "v1") is False
        assert vfs.stats == ["/m"]
        kept = await mount.index_store.list_dir("/m/a")
        assert kept.entries == [] and kept.version == "v1"
        assert (await mount.index_store.get("/m/f.txt")).entry is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["enoent", "none"])
async def test_listing_gate_refuses_what_the_check_cannot_confirm(
    outcome, caplog
):
    async with _versioned() as (vfs, mount, rec):
        if outcome == "enoent":
            vfs.raises = FileNotFoundError("/m")
        else:
            vfs.remote = None
        caplog.set_level(logging.DEBUG, logger="mirage.workspace.reconcile")
        await _store(mount, "/m/a", "v1")
        async with command_scope():
            assert await rec.may_serve_listing(mount, "/m/a", "v1") is False
        assert vfs.stats == ["/m"]
        assert (await mount.index_store.list_dir("/m/a")).version == "v1"
        logged = [
            r for r in caplog.records if r.name == "mirage.workspace.reconcile"
        ]
        assert logged == []


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [TypeError, AttributeError, NameError])
async def test_listing_gate_lets_a_programming_error_escape(error):
    async with _versioned() as (vfs, mount, rec):
        vfs.raises = error("bug")
        await _store(mount, "/m/a", "v1")
        async with command_scope():
            with pytest.raises(error, match="bug"):
                await rec.may_serve_listing(mount, "/m/a", "v1")


@pytest.mark.asyncio
async def test_listing_gate_refuses_silently_without_a_stat_op(
    caplog, monkeypatch
):
    async with _versioned(has_stat=False) as (vfs, mount, rec):
        asked: list[str] = []
        execute = mount.call

        async def recording(op_name, path, *args, **kwargs):
            asked.append(op_name)
            return await execute(op_name, path, *args, **kwargs)

        monkeypatch.setattr(mount, "call", recording)
        caplog.set_level(logging.DEBUG, logger="mirage.workspace.reconcile")
        await _store(mount, "/m/a", "v1")
        async with command_scope():
            assert await rec.may_serve_listing(mount, "/m/a", "v1") is False
        assert asked == ["stat"]
        assert [
            r for r in caplog.records if r.name == "mirage.workspace.reconcile"
        ] == []


async def _gate_in_command(rec, mount, folder: str, version: str) -> bool:
    async with command_scope():
        return await rec.may_serve_listing(mount, folder, version)


@pytest.mark.asyncio
async def test_listing_gate_never_shares_a_check_sent_before_the_command():
    # Command C starts after A's check was sent, so that check may predate
    # a change C must see: C sends its own.
    async with _versioned() as (vfs, mount, rec):
        vfs.hold = asyncio.Event()
        await _store(mount, "/m/a", "v1")
        first = asyncio.create_task(_gate_in_command(rec, mount, "/m/a", "v1"))
        await _sent(vfs)
        second = asyncio.create_task(
            _gate_in_command(rec, mount, "/m/a", "v1")
        )
        await _sent(vfs)
        vfs.hold.set()
        assert await first is True
        assert await second is True
        assert vfs.stats == ["/m", "/m"]


@pytest.mark.asyncio
async def test_listing_gate_stamps_a_check_when_it_is_sent():
    # Command D starts while A's check is in flight and gates after it
    # lands. The check was sent before D began, so its answer is not D's.
    async with _versioned() as (vfs, mount, rec):
        vfs.hold = asyncio.Event()
        await _store(mount, "/m/a", "v1")
        first = asyncio.create_task(_gate_in_command(rec, mount, "/m/a", "v1"))
        await _sent(vfs)
        async with command_scope():
            vfs.hold.set()
            assert await first is True
            assert await rec.may_serve_listing(mount, "/m/a", "v1") is True
        assert vfs.stats == ["/m", "/m"]


async def _gate_when_told(
    rec, mount, entered: asyncio.Event, go: asyncio.Event
) -> bool:
    async with command_scope():
        entered.set()
        await go.wait()
        return await rec.may_serve_listing(mount, "/m/a", "v1")


@pytest.mark.asyncio
async def test_listing_gate_shares_one_check_among_commands_already_running():
    async with _versioned() as (vfs, mount, rec):
        vfs.hold = asyncio.Event()
        go = asyncio.Event()
        entered = [asyncio.Event() for _ in range(7)]
        await _store(mount, "/m/a", "v1")
        tasks = [
            asyncio.create_task(_gate_when_told(rec, mount, e, go))
            for e in entered
        ]
        await asyncio.gather(*(e.wait() for e in entered))
        go.set()
        await _sent(vfs)
        for _ in range(50):
            await asyncio.sleep(0)
        vfs.hold.set()
        assert await asyncio.gather(*tasks) == [True] * 7
        assert vfs.stats == ["/m"]


@pytest.mark.asyncio
async def test_listing_gate_check_survives_its_first_waiter_cancelling():
    async with _versioned() as (vfs, mount, rec):
        vfs.hold = asyncio.Event()
        go = asyncio.Event()
        entered = [asyncio.Event(), asyncio.Event()]
        await _store(mount, "/m/a", "v1")
        owner = asyncio.create_task(
            _gate_when_told(rec, mount, entered[0], go)
        )
        peer = asyncio.create_task(_gate_when_told(rec, mount, entered[1], go))
        await asyncio.gather(*(e.wait() for e in entered))
        go.set()
        await _sent(vfs)
        for _ in range(50):
            await asyncio.sleep(0)
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner
        vfs.hold.set()
        assert await peer is True
        assert vfs.stats == ["/m"]


@pytest.mark.asyncio
async def test_listing_gate_outside_a_command_reuses_a_check_for_the_window(
    monkeypatch,
):
    now = [100.0]
    monkeypatch.setattr("mirage.cache.manager._now", lambda: now[0])
    async with _versioned() as (vfs, mount, rec):
        await _store(mount, "/m/a", "v1")
        assert await rec.may_serve_listing(mount, "/m/a", "v1") is True
        assert vfs.stats == ["/m"]
        now[0] += LISTING_TRUST_WINDOW / 2
        assert await rec.may_serve_listing(mount, "/m/a", "v1") is True
        assert vfs.stats == ["/m"]
        now[0] += LISTING_TRUST_WINDOW
        assert await rec.may_serve_listing(mount, "/m/a", "v1") is True
        assert vfs.stats == ["/m", "/m"]


@pytest.mark.asyncio
async def test_listing_gate_forgets_its_checks_when_the_store_changes():
    async with _versioned() as (vfs, mount, rec):
        await _store(mount, "/m/a", "v1")
        async with command_scope():
            served = await mount.index.list_dir("/m/a")
            assert served.entries == []
            assert vfs.stats == ["/m"]
            replacement = RAMIndexCacheStore(ttl=600)
            await replacement.set_dir("/m/a", [], version="v1")
            mount.index_store = replacement
            assert (await mount.index.list_dir("/m/a")).entries == []
        assert vfs.stats == ["/m", "/m"]


@pytest.mark.asyncio
async def test_the_probe_hints_the_mount_index_row():
    # The probe stats through a scratch store whose only lead is the
    # mount's own row: a backend with no path lookup (box) may address
    # that id once, and must confirm what comes back.
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        mount.read = ReadSpec(policy=ReadPolicy.FRESH)
        row = IndexEntry(id="F1", name="f.txt", resource_type="file")
        await mount.index_store.set_dir("/data", [("f.txt", row)])
        await mount.index_store.set_dir("/elsewhere", [("g.txt", row)])
        assert (await mount.index.get("/data/f.txt")).entry is not None
        assert (await mount.index_store.get("/elsewhere/g.txt")).entry
        seen = []

        async def capture(op, path, **kwargs):
            index = kwargs["index"]
            assert isinstance(index, ListingCheckStore)
            # Hints come through the mount's view, whose ownership check
            # keeps a row outside the mount from passing as a lead.
            assert await index.hint("/elsewhere/g.txt") is None
            seen.append(await index.hint("/data/f.txt"))
            return FileStat(
                name="f.txt", type=FileType.FILE, fingerprint="fp1"
            )

        mount.call = capture
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace)
        assert await rec.may_serve_cached(mount, "/data/f.txt") is True
        assert seen == [(await mount.index.get("/data/f.txt")).entry]
    finally:
        await ws.close()
