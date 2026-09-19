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

import os
from uuid import uuid4

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index.config import RedisIndexConfig
from mirage.types import ConsistencyPolicy, FileStat, FileType
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
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/f.txt")
    assert mount.vfs.supports_snapshot is False
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    assert await rec.may_serve_cached(mount, "/data/f.txt") is False


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
        monkeypatch.setattr(mount.vfs, "supports_snapshot", True)
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
            await rec.reconcile_read(mount, "/data/f.txt")
            assert await ws.cache.exists("/data/f.txt") == (probe == "fresh")
        elif probe == "failed":
            with pytest.raises(OSError, match="probe unavailable"):
                await rec.may_serve_cached(mount, "/data/f.txt")
        else:
            assert await rec.may_serve_cached(
                mount, "/data/f.txt") == (probe == "fresh")
            assert await ws.cache.exists("/data/f.txt") == (probe == "fresh")
    finally:
        await ws.close()
