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

import errno
import logging
import os
from uuid import uuid4

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index.config import RedisIndexConfig
from mirage.types import ConsistencyPolicy, FileStat, FileType
from mirage.utils.errors import enotsup
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace.reconcile import Reconciler
from tests.e2e.s3_mock import patch_s3_multi


async def _ws_with_overlay():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/f.txt", mode=0o600)
    return ws


@pytest.mark.asyncio
async def test_on_missing_evicts_and_gcs_overlay():
    ws = await _ws_with_overlay()
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.on_missing("/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_on_missing_keeps_symlink():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.symlink("/data/link", "/data/t", 1.0)
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.on_missing("/data/link")
    assert ws.namespace.readlink("/data/link") == "/data/t"


@pytest.mark.asyncio
async def test_on_op_missing_skips_under_lazy():
    ws = await _ws_with_overlay()
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.LAZY)
    await rec.on_op_missing("stat", "/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is not None


@pytest.mark.asyncio
async def test_on_op_missing_skips_non_revalidate_op():
    ws = await _ws_with_overlay()
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.on_op_missing("write", "/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is not None


@pytest.mark.asyncio
async def test_on_op_missing_gcs_on_always_stat():
    ws = await _ws_with_overlay()
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.on_op_missing("stat", "/data/f.txt")
    assert ws.namespace.meta_for("/data/f.txt") is None


@pytest.mark.asyncio
async def test_may_serve_cached_trusts_cache_under_lazy():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/f.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.LAZY)
    assert await rec.may_serve_cached(mount, "/data/f.txt") is True


@pytest.mark.asyncio
async def test_may_serve_cached_no_fingerprint_forces_reread():
    """A stat that carries no content token cannot verify the copy.

    The path exists and is cached, so the only reason to refuse is the
    verdict: RAM stats without a fingerprint, which is UNKNOWN, which
    evicts. This used to be answered by a ``SUPPORTS_SNAPSHOT``
    short-circuit that never probed at all.
    """
    resource = RAMVFS()
    resource._store.files["/f.txt"] = b"v1"
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        stat = await mount.execute_op("stat", "/data/f.txt")
        assert stat is not None and stat.fingerprint is None
        rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
        assert await rec.may_serve_cached(mount, "/data/f.txt") is False
        assert not await ws.cache.exists("/data/f.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_may_serve_cached_serves_a_fingerprinted_live_only_backend():
    """A live-only backend that DOES stamp a fingerprint keeps its cache.

    ``SUPPORTS_SNAPSHOT`` is about whether a mount can be snapshotted, not
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
        assert mount.vfs.SUPPORTS_SNAPSHOT is False
        real = mount.execute_op

        async def fingerprinted(op, path, **kwargs):
            stat = await real(op, path, **kwargs)
            return (stat.model_copy(update={"fingerprint": "fp1"})
                    if op == "stat" and stat is not None else stat)

        mount.execute_op = fingerprinted
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
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
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.reconcile_read(mount, "/data/gone.txt")
    assert ws.namespace.meta_for("/data/gone.txt") is None


@pytest.mark.asyncio
async def test_reconcile_read_noop_without_overlay_or_cache():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/plain.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.reconcile_read(mount, "/data/plain.txt")


@pytest.mark.asyncio
async def test_reconcile_read_skips_under_lazy():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    mount = ws.namespace.mount_for("/data/gone.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.LAZY)
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

        async def failing(op, path, **_kwargs):
            if failure == "no_stat_op":
                raise enotsup("stubborn", op, path)
            raise OSError(errno.EIO, "backend stat unavailable")

        mount.execute_op = failing
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
        with caplog.at_level(logging.WARNING,
                             logger="mirage.workspace.reconcile"):
            assert await rec.may_serve_cached(mount, "/data/f.txt") is False
        assert not await ws.cache.exists("/data/f.txt")
        assert bool(caplog.records) is (failure == "flaky")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_reconcile_read_skips_a_cached_path_the_gate_will_probe():
    """The gate owns cached-byte freshness; this owns overlay GC.

    A command whose reads go through the cache gate probes each operand
    there, so probing it here as well would stat twice for one warm read.
    An overlay is still probed, because the gate never sees one.
    """
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for("/data/f.txt")
        probed: list[str] = []

        async def stat(_op, path, **_kwargs):
            probed.append(path)
            return None

        mount.execute_op = stat
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")
        rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)

        await rec.reconcile_read(mount, "/data/f.txt", cached_gated=True)
        assert probed == [], "the gate probes this path itself"

        await rec.reconcile_read(mount, "/data/f.txt", cached_gated=False)
        assert probed == ["/data/f.txt"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_reconcile_read_still_probes_an_overlay_the_gate_cannot_see():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.namespace.ensure_loaded()
        await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
        mount = ws.namespace.mount_for("/data/gone.txt")
        rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
        await rec.reconcile_read(mount, "/data/gone.txt", cached_gated=True)
        assert ws.namespace.meta_for("/data/gone.txt") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("index_type", ["ram", "redis"])
@pytest.mark.parametrize("surface", ["shell", "fs"])
@pytest.mark.parametrize("change", ["overwrite", "delete"])
async def test_always_probes_live_s3_with_warm_index(index_type, surface,
                                                     change):
    index = None
    if index_type == "redis":
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        index = RedisIndexConfig(url=url, key_prefix=f"reconcile:{uuid4()}:")
    objects = {"f.txt": b"v1"}
    vfs = S3VFS(
        S3Config(bucket="test-bucket",
                 region="us-east-1",
                 aws_access_key_id="fake",
                 aws_secret_access_key="fake"))
    with patch_s3_multi({"test-bucket": objects}):
        ws = Workspace({"/s3": vfs},
                       index=index,
                       consistency=ConsistencyPolicy.ALWAYS)
        try:
            assert (await ws.shell("ls /s3/")).exit_code == 0
            assert (await vfs.index.get("/s3/f.txt")).entry is not None
            assert (await ws.shell("cat /s3/f.txt")).stdout == b"v1"
            assert await ws.cache.exists("/s3/f.txt")
            if change == "overwrite":
                objects["f.txt"] = b"v2"
            else:
                del objects["f.txt"]
            if surface == "shell":
                result = await ws.shell("cat /s3/f.txt")
                assert result.stdout == (b"v2"
                                         if change == "overwrite" else b"")
                assert result.exit_code == (0 if change == "overwrite" else 1)
            elif change == "overwrite":
                assert await ws.vfs.read("/s3/f.txt") == b"v2"
            else:
                with pytest.raises(FileNotFoundError):
                    await ws.vfs.read("/s3/f.txt")
        finally:
            await vfs.index.clear()
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("probe", ["unknown", "none", "failed", "fresh"])
@pytest.mark.parametrize("surface", ["shell", "gate"])
async def test_unverified_probe_cannot_serve_cached_bytes(
        monkeypatch, probe, surface):
    ws = Workspace({"/data": RAMVFS()})
    try:
        mount = ws.namespace.mount_for("/data/f.txt")
        monkeypatch.setattr(mount.vfs, "SUPPORTS_SNAPSHOT", True)
        await ws.cache.set("/data/f.txt", b"v1", fingerprint="fp1")

        async def stat(*args, **kwargs):
            if probe == "failed":
                raise OSError("probe unavailable")
            if probe == "none":
                return None
            return FileStat(name="f.txt",
                            type=FileType.FILE,
                            fingerprint="fp1" if probe == "fresh" else None)

        monkeypatch.setattr(mount, "execute_op", stat)
        rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
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
            assert await rec.may_serve_cached(
                mount, "/data/f.txt") == (probe == "fresh")
            assert await ws.cache.exists("/data/f.txt") == (probe == "fresh")
    finally:
        await ws.close()
