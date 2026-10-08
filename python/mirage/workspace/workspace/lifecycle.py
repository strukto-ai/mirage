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
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from types import ModuleType
from typing import Any, cast

from mirage.cache.file.mixin import FileCacheMixin
from mirage.concurrency.limiter import run_blocking
from mirage.observe.store import ObserverStore
from mirage.process.supervisor import ProcessSupervisor
from mirage.runtime.python.host.fs import os_routing
from mirage.runtime.python.host.open import make_open
from mirage.shell.job_table import JobTable, cancel_job
from mirage.workspace.files import Files
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.session.store import SessionStore
from mirage.workspace.store import WorkspaceStateStore
from mirage.workspace.workspace.kernel_mounts import KernelMounts
from mirage.workspace.workspace.watch import WatchManager

# An attribute a ``with`` block replaced: the module, the name and what
# the name held before.
Patched = tuple[ModuleType, str, Callable[..., Any]]


@dataclass(slots=True)
class CloseDeps:
    """What closing a workspace releases (``close_workspace``).

    Attributes:
        sessions (SessionManager): settled first, so a pending write
            lands.
        watch (WatchManager): detached before anything it reads goes.
        cache (FileCacheMixin): cleared and closed last.
        owns_state_store (bool): the workspace built its state store.
        state_store (WorkspaceStateStore): where the state lives.
        closers (list[Callable[[], Awaitable[None]]]): the policy
            scripts and line runtimes, closed once the jobs stop.
        job_table (JobTable): the background jobs.
        processes (ProcessSupervisor): the managed runners.
        registry (MountRegistry): the mounts.
        shared_mounts (set[int]): ids of the VFSes a sibling workspace
            still uses.
        kernel_mounts (KernelMounts): the FUSE mounts.
        drop_state (bool): delete the workspace's state from its store
            once nothing writes it any more, before the store closes.
        workspace_id (str): the workspace whose state is dropped.
        planes (Sequence[NamespaceStore | ObserverStore | SessionStore]):
            the stores the state lives in, however they were wired.
    """

    sessions: SessionManager
    watch: WatchManager
    cache: FileCacheMixin
    owns_state_store: bool
    state_store: WorkspaceStateStore
    closers: list[Callable[[], Awaitable[None]]]
    job_table: JobTable
    processes: ProcessSupervisor
    registry: MountRegistry
    shared_mounts: set[int]
    kernel_mounts: KernelMounts
    drop_state: bool
    workspace_id: str
    planes: Sequence[NamespaceStore | ObserverStore | SessionStore]


def patch_process(
    files: Files,
    loop: asyncio.AbstractEventLoop,
) -> list[Patched]:
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
        files (Files): the workspace's ``ws.vfs``.
        loop (asyncio.AbstractEventLoop): the block's loop.

    Returns:
        list[Patched]: what the block replaced, for ``unpatch_process``.
    """
    opener = cast(Any, make_open(files, loop))
    routing = os_routing(files, loop)
    patched: list[Patched] = [
        (builtins, "open", builtins.open),
        (io, "open", io.open),
        *((os, name, getattr(os, name)) for name in routing),
    ]
    builtins.open = opener
    io.open = opener
    for name, fn in routing.items():
        setattr(os, name, fn)
    return patched


def unpatch_process(patched: list[Patched]) -> None:
    """Restore the process-level ``open`` and ``os`` patched on entry.

    Args:
        patched (list[Patched]): what ``patch_process`` replaced.
    """
    for module, name, fn in patched:
        setattr(module, name, fn)


async def close_local_parts(deps: CloseDeps) -> None:
    """Release kernel mounts and remaining local bookkeeping.

    Args:
        deps (CloseDeps): what the workspace owns.
    """
    try:
        await run_blocking(deps.kernel_mounts.close)
    finally:
        for job in deps.job_table.all_running_jobs():
            cancel_job(job)


async def _drop_state(deps: CloseDeps) -> None:
    """Delete the workspace's state: its own planes, then its store scope.

    A plane store passed in directly is not the state store's, so the
    store's drop alone would leave it holding the workspace.

    Args:
        deps (CloseDeps): what the workspace owns.
    """
    for plane in deps.planes:
        await plane.clear()
    await deps.state_store.drop(deps.workspace_id)


async def close_workspace(deps: CloseDeps) -> list[BaseException]:
    """Release everything the workspace owns; the caller runs it once.

    Order matters: the watch runtime goes first (it reads mounts), then
    background jobs, then the line runtimes, then mounts not shared
    with a sibling workspace, then the state store if this workspace
    built it, then the kernel mounts, and finally the cache.

    Jobs are settled here rather than merely cancelled. ``kill_all``
    records the outcome and finishes each console, which is what releases
    a reader parked on ``wait_finished``; a bare cancel leaves the job
    RUNNING with no ending chunk and that reader waits forever. The
    supervisor then joins the managed runners before their mounts are
    released, and the consoles close only after that join: a runner still
    unwinding writes its ending chunk as it settles, and a Redis console
    written after close reconnects a client that nothing closes again.

    Args:
        deps (CloseDeps): what the workspace owns.

    Returns:
        list[BaseException]: what failed, in order; teardown went on
        past each.
    """
    failures: list[BaseException] = []

    async def settle(*work: Awaitable[Any]) -> None:
        results = await asyncio.gather(*work, return_exceptions=True)
        failures.extend(
            result for result in results if isinstance(result, BaseException)
        )

    await settle(deps.sessions.settle())
    await settle(deps.watch.detach())
    await settle(deps.job_table.kill_all())
    try:
        deps.processes.stop()
    except Exception as exc:
        failures.append(exc)
    for close in deps.closers:
        await settle(close())
    await settle(deps.processes.drain())
    await settle(deps.job_table.close_consoles())
    await settle(
        *(
            asyncio.shield(task)
            for task in list(deps.registry.retiring_mounts.values())
        )
    )
    mounts = {
        id(mount.vfs): mount.vfs
        for mount in deps.registry.mounts()
        if id(mount.vfs) not in deps.shared_mounts
    }
    await settle(*(vfs.close() for vfs in mounts.values()))
    stores = {
        id(mount.index_store): mount.index_store
        for mount in deps.registry.mounts()
    }
    await settle(*(store.close() for store in stores.values()))
    if deps.drop_state:
        # The kernel mounts still serve requests until the sync parts
        # unmount them, and a request may write the very state being
        # deleted, so they go first. A failed drop must not skip the
        # rest of teardown: a mount left up keeps the process alive.
        try:
            await run_blocking(deps.kernel_mounts.close)
        except Exception as exc:
            failures.append(exc)
        await settle(_drop_state(deps))
    if deps.owns_state_store:
        await settle(deps.state_store.close())
    await settle(close_local_parts(deps))
    await settle(deps.cache.clear())
    await settle(deps.cache.close())
    return failures
