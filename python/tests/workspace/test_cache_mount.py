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

from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.constants import SCOPE_ERROR
from mirage.core.disk.read import read_bytes
from mirage.core.disk.readdir import readdir
from mirage.io.types import IOResult
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import ConsistencyPolicy, MountMode, PathSpec
from mirage.utils.glob_walk import make_resolve_glob
from mirage.workspace import Workspace

resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)


@command("stat", resource="disk", spec=SPECS["stat"], filetype=".zzz")
async def stat_zzz_disk(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin=None,
    index=None,
    **_extra: object,
) -> tuple[bytes | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    raw = await read_bytes(accessor, paths[0])
    return b"CUSTOM DISK STAT %d\n" % len(raw), IOResult(
        reads={paths[0].mount_path: raw}, cache=[paths[0].mount_path])


@pytest.mark.asyncio
async def test_cache_decoupled_from_root_mount():
    """The file cache is a hidden store reached via ``registry.file_cache``,
    not the virtual root mount's resource. When no ``/`` is mounted the root
    is an ordinary empty RAM mount at ``/`` (a normal entry in ``_mounts``)
    and never holds the cache."""
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    assert ws._registry.file_cache is ws.cache
    assert ws._registry.root_mount.resource is not ws.cache
    assert ws._registry.root_mount.resource.caches_reads is False
    assert ws._registry.root_mount.prefix == "/"
    assert ws._registry.root_mount in ws._registry.mounts()


@pytest.mark.asyncio
async def test_warm_read_stays_on_real_mount(tmp_path):
    """Read-through: the second (cached) read still runs the REAL mount's
    command. The cache is a hidden store, not a mount, so a warm read serves
    the cached bytes while the command stays on its real mount and keeps its
    custom handler."""
    (tmp_path / "example.zzz").write_bytes(b"payload")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/": disk}, mode=MountMode.READ)
    ws.mount("/").register_fns([stat_zzz_disk])

    first = await ws.execute("stat /example.zzz")
    second = await ws.execute("stat /example.zzz")
    assert "CUSTOM DISK STAT" in (await first.stdout_str())
    assert "CUSTOM DISK STAT" in (await second.stdout_str()), (
        "warm read lost the real mount's custom handler; read-through should "
        "keep the command on the real mount")


@pytest.mark.asyncio
async def test_cross_mount_read_serves_cache(tmp_path):
    """A cross-mount read relays each operand through ``execute_op``, and the
    op-layer read-through serves a warm operand from cache. Proven under LAZY
    by mutating the file out-of-band: the cross-mount read still returns the
    cached v1."""
    (tmp_path / "a.txt").write_bytes(b"v1\n")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({
        "/d/": disk,
        "/r/": RAMResource()
    },
                   mode=MountMode.WRITE,
                   consistency=ConsistencyPolicy.LAZY)
    await ws.execute("echo hi > /r/b.txt")
    await (await ws.execute("cat /d/a.txt")).stdout_str()
    (tmp_path / "a.txt").write_bytes(b"v2\n")
    out = await (await ws.execute("cat /d/a.txt /r/b.txt")).stdout_str()
    assert "v1" in out and "v2" not in out, (
        f"cross-mount read did not serve the warm operand from cache: {out!r}")


def _stat_scope(path):
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path="",
                    resolved=True)


@pytest.mark.asyncio
async def test_stat_gcs_orphaned_overlay_under_always():
    """A remotely-deleted path leaves an orphaned attribute overlay. Under
    ALWAYS, a stat that the backend reports gone GCs the overlay node."""
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   consistency=ConsistencyPolicy.ALWAYS)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)
    assert ws.namespace.meta_for("/data/gone.txt") is not None

    with pytest.raises(FileNotFoundError):
        await ws.dispatch("stat", _stat_scope("/data/gone.txt"))

    assert ws.namespace.meta_for("/data/gone.txt") is None


@pytest.mark.asyncio
async def test_shell_stat_gcs_orphan_under_always():
    """A single-mount shell read (not the dispatcher) reconciles via the
    registry: under ALWAYS, a stat the backend reports gone GCs the overlay."""
    ram = RAMResource()
    ram.caches_reads = True
    ws = Workspace({"/r/": ram},
                   mode=MountMode.WRITE,
                   consistency=ConsistencyPolicy.ALWAYS)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/r/gone.txt", mode=0o600)
    assert ws.namespace.meta_for("/r/gone.txt") is not None

    await ws.execute("stat /r/gone.txt")

    assert ws.namespace.meta_for("/r/gone.txt") is None


@pytest.mark.asyncio
async def test_stat_keeps_overlay_under_lazy():
    """Under LAZY the overlay is left in place (no reconcile)."""
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   consistency=ConsistencyPolicy.LAZY)
    await ws.namespace.ensure_loaded()
    await ws.namespace.set_attrs("/data/gone.txt", mode=0o600)

    with pytest.raises(FileNotFoundError):
        await ws.dispatch("stat", _stat_scope("/data/gone.txt"))

    assert ws.namespace.meta_for("/data/gone.txt") is not None
