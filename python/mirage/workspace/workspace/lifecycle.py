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
import builtins
import io
import os
from typing import TYPE_CHECKING, Any, cast

from mirage.ops.open import make_open
from mirage.ops.os_patch import os_routing
from mirage.shell.job_table import cancel_job

if TYPE_CHECKING:
    from mirage.workspace.workspace import Workspace


def patch_process(ws: "Workspace", ) -> None:
    """Point ``open`` and ``os`` at the workspace for a ``with`` block.

    Each door is installed as an attribute on the module that owns the
    name, never as a replacement module in ``sys.modules``, because a
    module imported before the block holds its own reference to the
    real one: a script whose ``import os`` sits at the top of the file
    would never have seen a swapped entry, and neither would
    ``pathlib``, ``shutil`` or ``glob``. Patching the attribute reaches
    all of them, and ``os.path`` comes along for free because
    ``posixpath`` reads ``os.stat`` off that same module at call time.
    ``open`` needs the same treatment twice: it is also ``io.open``,
    which is the one ``pathlib`` calls.

    The block gets ONE event loop, driven a call at a time, that every
    patched call and the closing ``close()`` share. Without it each call
    reached ``asyncio.run``, so a resource holding a connection pool bound
    that pool to a loop that was closed before the next call, and the
    close at the end of the block died with "Event loop is closed" (redis
    is the one that shows it; any pooled async client would).

    Args:
        ws: the workspace entering context-manager scope.
    """
    ws._original_open = builtins.open
    ws._original_io_open = io.open
    ws._vfs_loop = asyncio.new_event_loop()
    opener = cast(Any, make_open(ws._ops, ws._vfs_loop))
    builtins.open = opener
    io.open = opener
    routing = os_routing(ws._ops, ws._vfs_loop)
    ws._original_os_names = {name: getattr(os, name) for name in routing}
    for name, fn in routing.items():
        setattr(os, name, fn)


def unpatch_process(ws: "Workspace", ) -> None:
    """Restore the process-level ``open`` and ``os`` patched on entry.

    Args:
        ws: the workspace leaving context-manager scope.
    """
    if ws._original_open is not None:
        builtins.open = ws._original_open
    if ws._original_io_open is not None:
        io.open = ws._original_io_open
    for name, fn in (ws._original_os_names or {}).items():
        setattr(os, name, fn)
    ws._original_os_names = None


def stop_vfs_loop(ws: "Workspace", ) -> None:
    """Close the loop ``patch_process`` opened, after the workspace close.

    Args:
        ws: the workspace leaving context-manager scope.
    """
    loop = ws._vfs_loop
    if loop is None:
        return
    ws._vfs_loop = None
    loop.close()


def close_sync_parts(ws: "Workspace", ) -> None:
    """Tear down everything that needs no event loop (idempotent).

    Kernel mounts, running jobs, and in-flight cache drains; the
    async half (``close_async``) owns resources and stores.

    Args:
        ws: the workspace being closed.
    """
    if ws._closed:
        return
    ws._closed = True
    ws._kernel_mounts.close()
    for job in ws.job_table.running_jobs():
        # Last resort only: with no loop to await on, a job can be asked
        # to stop but not settled, so it keeps its RUNNING status and its
        # console never ends. ``close_async`` settles first, so anything
        # still running here arrived by a path that had no loop at all.
        cancel_job(job)
    for task in ws._cache._drain_tasks.values():
        task.cancel()
    ws._cache._drain_tasks.clear()


async def close_async(ws: "Workspace", ) -> None:
    """Release everything the workspace owns, exactly once.

    Order matters: the watch runtime goes first (it reads mounts), then
    background jobs, then the line runtimes, then resources not shared
    with a sibling workspace, then the state store if this workspace
    built it, then the sync parts, and finally the cache once its drains
    have settled.

    Jobs are settled here rather than merely cancelled. ``kill_all``
    records the outcome and finishes each console, which is what releases
    a reader parked on ``wait_finished``; a bare cancel leaves the job
    RUNNING with no ending chunk and that reader waits forever. It never
    joins the runner, so this cannot block shutdown on a job mid-write,
    and it happens before any resource closes so a job cannot keep
    touching one that is already gone.

    Args:
        ws: the workspace being closed.
    """
    async with ws._close_lock:
        if ws._async_closed:
            return
        # First: unmounting an nfs export makes the kernel client flush
        # its dirty pages as final WRITEs, which need both a live server
        # and the resources those writes land in.
        await ws._kernel_mounts.close_nfs()
        await ws._watch.detach()
        await ws.job_table.kill_all()
        await ws.job_table.close_consoles()
        drain_tasks = list(ws._cache._drain_tasks.values())
        await ws._script_policy.close()
        for line_runtime in ws._runtimes.entries:
            await line_runtime.close()
        resources = {
            id(mount.resource): mount.resource
            for mount in ws._registry.mounts()
            if id(mount.resource) not in ws._shared_resources
        }
        await asyncio.gather(*(resource.close()
                               for resource in resources.values()))
        if ws._owns_state_store:
            await ws._state_store.close()
        close_sync_parts(ws)
        for task in drain_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        try:
            await ws._cache.clear()
        finally:
            await ws._cache.close()
        ws._async_closed = True
