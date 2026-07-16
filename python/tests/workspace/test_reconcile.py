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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.types import ConsistencyPolicy
from mirage.workspace.reconcile import Reconciler


async def _ws_with_overlay():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
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
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
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
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/f.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.LAZY)
    assert await rec.may_serve_cached(mount, "/data/f.txt") is True


@pytest.mark.asyncio
async def test_may_serve_cached_no_fingerprint_forces_reread():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/f.txt")
    assert mount.resource.SUPPORTS_SNAPSHOT is False
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    assert await rec.may_serve_cached(mount, "/data/f.txt") is False


@pytest.mark.asyncio
async def test_reconcile_read_gcs_orphan_on_delete():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    mount = ws.namespace.mount_for("/data/gone.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.reconcile_read(mount, "/data/gone.txt")
    assert ws.namespace.meta_for("/data/gone.txt") is None


@pytest.mark.asyncio
async def test_reconcile_read_noop_without_overlay_or_cache():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    mount = ws.namespace.mount_for("/data/plain.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.ALWAYS)
    await rec.reconcile_read(mount, "/data/plain.txt")


@pytest.mark.asyncio
async def test_reconcile_read_skips_under_lazy():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    mount = ws.namespace.mount_for("/data/gone.txt")
    rec = Reconciler(ws.cache, ws.namespace, ConsistencyPolicy.LAZY)
    await rec.reconcile_read(mount, "/data/gone.txt")
    assert ws.namespace.meta_for("/data/gone.txt") is not None
