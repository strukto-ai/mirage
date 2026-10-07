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
from collections.abc import Awaitable
from typing import TYPE_CHECKING, Any, cast

from mirage.concurrency.limiter import run_blocking
from mirage.runtime.python.host.fs import os_routing
from mirage.runtime.python.host.open import make_open
from mirage.shell.job_table import cancel_job

if TYPE_CHECKING:
    from mirage.workspace.workspace import Workspace


def patch_process(
    ws: "Workspace",
) -> None:
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
    reached ``asyncio.run``, so a VFS holding a connection pool bound
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


def unpatch_process(
    ws: "Workspace",
) -> None:
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


def stop_vfs_loop(
    ws: "Workspace",
) -> None:
    """Close the loop ``patch_process`` opened, after the workspace close.

    Args:
        ws: the workspace leaving context-manager scope.
    """
    loop = ws._vfs_loop
    if loop is None:
        return
    ws._vfs_loop = None
    loop.close()


async def close_local_parts(
    ws: "Workspace",
) -> None:
    """Release kernel mounts and remaining local bookkeeping.

    Args:
        ws: the workspace being closed.
    """
    if ws._closed:
        return
    ws._closed = True
    try:
        await run_blocking(ws._kernel_mounts.close)
    finally:
        for job in ws.job_table.all_running_jobs():
            cancel_job(job)
        for task in ws._cache._drain_tasks.values():
            task.cancel()
        ws._cache._drain_tasks.clear()


async def _drop_state(ws: "Workspace") -> None:
    """Delete the workspace's state: its own planes, then its store scope.

    A plane store passed in directly is not the state store's, so the
    store's drop alone would leave it holding the workspace.

    Args:
        ws: the workspace being deleted.
    """
    for plane in ws._planes:
        await plane.clear()
    await ws._state_store.drop(ws.workspace_id)


async def close_async(
    ws: "Workspace",
    *,
    drop_state: bool = False,
) -> None:
    """Release everything the workspace owns, exactly once.

    Order matters: the watch runtime goes first (it reads mounts), then
    background jobs, then the line runtimes, then mounts not shared
    with a sibling workspace, then the state store if this workspace
    built it, then the kernel mounts, and finally the cache once its drains
    have settled.

    Jobs are settled here rather than merely cancelled. ``kill_all``
    records the outcome and finishes each console, which is what releases
    a reader parked on ``wait_finished``; a bare cancel leaves the job
    RUNNING with no ending chunk and that reader waits forever. The
    supervisor then joins the managed runners before their mounts are
    released, and the consoles close only after that join: a runner still
    unwinding writes its ending chunk as it settles, and a Redis console
    written after close reconnects a client that nothing closes again.

    Args:
        ws: the workspace being closed.
        drop_state (bool): delete the workspace's state from its store
            once nothing writes it any more, before the store closes.
    """
    # Stop lifecycle mutations before teardown yields or captures its close
    # lists. Keep _closed separate so runtime journals can still dispatch.
    ws._closing = True
    async with ws._close_lock:
        if ws._async_closed:
            if ws._close_error is not None:
                raise ws._close_error
            return
        failures: list[BaseException] = []

        async def settle(*work: Awaitable[Any]) -> None:
            results = await asyncio.gather(*work, return_exceptions=True)
            failures.extend(
                result
                for result in results
                if isinstance(result, BaseException)
            )

        await settle(ws._session_mgr.settle())
        await settle(ws._watch.detach())
        await settle(ws.job_table.kill_all())
        try:
            ws.processes.stop()
        except Exception as exc:
            failures.append(exc)
        drain_tasks = list(ws._cache._drain_tasks.values())
        await settle(ws._script_policy.close())
        await settle(ws._runtimes.close())
        await settle(ws.processes.drain())
        await settle(ws.job_table.close_consoles())
        await settle(
            *(
                asyncio.shield(task)
                for task in list(ws._registry.retiring_mounts.values())
            )
        )
        mounts = {
            id(mount.vfs): mount.vfs
            for mount in ws._registry.mounts()
            if id(mount.vfs) not in ws._shared_mounts
        }
        await settle(*(vfs.close() for vfs in mounts.values()))
        stores = {
            id(mount.index_store): mount.index_store
            for mount in ws._registry.mounts()
        }
        await settle(*(store.close() for store in stores.values()))
        if drop_state:
            # The kernel mounts still serve requests until the sync parts
            # unmount them, and a request may write the very state being
            # deleted, so they go first. A failed drop must not skip the
            # rest of teardown: a mount left up keeps the process alive.
            try:
                await run_blocking(ws._kernel_mounts.close)
            except Exception as exc:
                failures.append(exc)
            ws._state_dropped = True
            await settle(_drop_state(ws))
        if ws._owns_state_store:
            await settle(ws._state_store.close())
        await settle(close_local_parts(ws))
        drains = await asyncio.gather(*drain_tasks, return_exceptions=True)
        failures.extend(
            result
            for result in drains
            if isinstance(result, BaseException)
            and not isinstance(result, asyncio.CancelledError)
        )
        await settle(ws._cache.clear())
        await settle(ws._cache.close())
        ws._async_closed = True
        if failures:
            ws._close_error = (
                failures[0]
                if len(failures) == 1
                else BaseExceptionGroup("workspace teardown failed", failures)
            )
            raise ws._close_error
