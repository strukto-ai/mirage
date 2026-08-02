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
import sys
from typing import Any, cast

from mirage.ops.open import make_open
from mirage.ops.os_patch import make_os_module


def patch_process(ws) -> None:
    """Point ``open`` and ``os`` at the workspace for a ``with`` block.

    Args:
        ws: the workspace entering context-manager scope.
    """
    ws._original_open = builtins.open
    ws._original_os = sys.modules["os"]
    builtins.open = cast(Any, make_open(ws._ops))
    sys.modules["os"] = make_os_module(ws._ops)


def unpatch_process(ws) -> None:
    """Restore the process-level ``open`` and ``os`` patched on entry.

    Args:
        ws: the workspace leaving context-manager scope.
    """
    builtins.open = ws._original_open
    sys.modules["os"] = ws._original_os


def close_sync_parts(ws) -> None:
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
        ws.job_table.kill(job.id)
    for task in ws._cache._drain_tasks.values():
        task.cancel()
    ws._cache._drain_tasks.clear()


async def close_async(ws) -> None:
    """Release everything the workspace owns, exactly once.

    Order matters: the watch runtime and line runtimes go first (they
    read mounts), then resources not shared with a sibling workspace,
    then the state store if this workspace built it, then the sync
    parts, and finally the cache once its drains have settled.

    Args:
        ws: the workspace being closed.
    """
    async with ws._close_lock:
        if ws._async_closed:
            return
        await ws._watch.detach()
        drain_tasks = list(ws._cache._drain_tasks.values())
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
