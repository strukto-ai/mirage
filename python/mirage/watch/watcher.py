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
from dataclasses import replace
from typing import Protocol

from mirage.types import ChangeKind, PathSpec, ResourceChange
from mirage.watch.base import SupportsChanges, WatchRuntime
from mirage.watch.constants import DEFAULT_POLL_INTERVAL
from mirage.watch.queue.base import QueueClosed, QueueFactory, WatchQueue
from mirage.watch.queue.ram import RAMWatchQueue
from mirage.watch.source import Source, Subscriber
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import (MountCommandUnsupported,
                                             MountRegistry)

logger = logging.getLogger(__name__)


class WatchableWorkspace(Protocol):
    """What ``enable_watch`` needs from a workspace.

    ``mirage.workspace.workspace.Workspace`` satisfies this
    structurally; depending on the protocol (not the concrete class)
    keeps the watch package off the workspace facade, the same idiom as
    ``ReadReconciler`` in the mount registry.
    """

    @property
    def registry(self) -> MountRegistry:
        ...

    def attach_watch_runtime(self, runtime: WatchRuntime) -> None:
        ...


class Watcher:
    """Watch runtime: per-(mount, root) pollers feeding consumer queues.

    Ordering guarantee: cache invalidation for a pulled delta completes
    before any of its changes reach a subscriber queue, so a consumer
    reacting to a change always reads fresh content.
    """

    def __init__(self,
                 registry: MountRegistry,
                 poll_interval: float = DEFAULT_POLL_INTERVAL,
                 queue_factory: QueueFactory = RAMWatchQueue) -> None:
        """Args:
            registry (MountRegistry): Mount table of the workspace.
            poll_interval (float): Seconds between delta pulls.
            queue_factory (QueueFactory): Builds the delivery queue for
                a watch root when the caller does not supply one.
        """
        self._registry = registry
        self._poll_interval = poll_interval
        self._queue_factory = queue_factory
        self._sources: dict[tuple[str, str], Source] = {}
        self._closed = False

    def _resolve_root(self, path: PathSpec) -> tuple[MountEntry, PathSpec]:
        """Resolve a watch path to its mount and a normalized root.

        Args:
            path (PathSpec): Caller-supplied watch path; only
                ``virtual`` is trusted, the mount framing is rebuilt.

        Raises:
            MountCommandUnsupported: The mount's resource has no
                change capability.
        """
        entry = self._registry.mount_for(path.virtual)
        resource = entry.resource
        if not isinstance(resource, SupportsChanges):
            raise MountCommandUnsupported("watch", resource.name, path.virtual)
        return entry, self._frame(entry, path.virtual)

    def _frame(self, entry: MountEntry, virtual: str) -> PathSpec:
        """Rebuild a PathSpec with mount-relative framing.

        The caller-supplied virtual path may carry any resource_path;
        cache invalidation needs the real mount-relative one, so it is
        recomputed from the mount prefix.

        Args:
            entry (MountEntry): Mount owning the path.
            virtual (str): Workspace-virtual path.
        """
        norm = "/" + virtual.strip("/")
        resource_path = norm[len(entry.prefix):] if norm.startswith(
            entry.prefix) else ""
        return PathSpec.from_str_path(norm, resource_path=resource_path)

    def _matches(self, sub: Subscriber, change: ResourceChange) -> bool:
        """Whether a change falls inside a subscriber's scope.

        Args:
            sub (Subscriber): Subscriber scope.
            change (ResourceChange): Candidate change.
        """
        root = sub.root_virtual.rstrip("/")
        virtual = change.path.virtual
        if virtual == root:
            return True
        if not virtual.startswith(root + "/"):
            return False
        if sub.recursive:
            return True
        return "/" not in virtual[len(root) + 1:]

    async def _invalidate(self, entry: MountEntry,
                          change: ResourceChange) -> None:
        """Evict cache for one change before it is delivered.

        Args:
            entry (MountEntry): Mount owning the change path.
            change (ResourceChange): Change whose path is now stale.
        """
        manager = entry.cache_manager
        if manager is None:
            return
        if change.kind is ChangeKind.DELETE:
            await manager.invalidate_after_unlink(change.path)
        else:
            await manager.invalidate_after_write(change.path)

    async def _dispatch(self, source: Source, changes: tuple[ResourceChange,
                                                             ...]) -> None:
        """Invalidate caches for ``changes``, then deliver them to the
        source's subscribers.

        Args:
            source (Source): Source that pulled the changes.
            changes (tuple[ResourceChange, ...]): Changes to deliver.
        """
        for change in changes:
            await self._invalidate(source.entry, change)
        for change in changes:
            for sub in source.subscribers:
                if self._matches(sub, change):
                    await sub.queue.push(change)

    async def _run_source(self, source: Source) -> None:
        """Poll loop: pull, invalidate, deliver, wait.

        Args:
            source (Source): Source to drive.
        """
        while True:
            try:
                delta = await source.hook.pull(source.root, source.checkpoint)
                source.checkpoint = delta.checkpoint
                if delta.changes:
                    await self._dispatch(source, delta.changes)
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failed pull must not kill the loop: the checkpoint
                # is untouched, so the next pull re-derives everything.
                logger.warning("watch pull failed for %s",
                               source.root.virtual,
                               exc_info=True)
            source.wake.clear()
            try:
                await asyncio.wait_for(source.wake.wait(),
                                       timeout=self._poll_interval)
            except TimeoutError:
                # Timeout is the poll cadence, not an error.
                logger.debug("watch poll tick for %s", source.root.virtual)

    def _get_source(self, entry: MountEntry, root: PathSpec) -> Source:
        """Return the shared source for (mount, root), starting its
        poll loop on first use.

        Args:
            entry (MountEntry): Mount owning the subtree.
            root (PathSpec): Normalized watch root.
        """
        key = (entry.prefix, root.virtual)
        source = self._sources.get(key)
        if source is None:
            resource = entry.resource
            assert isinstance(resource, SupportsChanges)
            source = Source(entry=entry, root=root, hook=resource.delta_hook())
            source.task = asyncio.create_task(self._run_source(source))
            self._sources[key] = source
        return source

    async def watch(
            self,
            path: PathSpec,
            *,
            recursive: bool = True,
            queue: WatchQueue | None = None) -> AsyncIterator[ResourceChange]:
        """Stream changes under ``path`` until the caller stops
        iterating or the watcher closes.

        Args:
            path (PathSpec): Watch root; the mount is resolved from it.
            recursive (bool): Deliver descendants beyond direct
                children.
            queue (WatchQueue | None): Delivery queue override; the
                watcher's factory builds one when omitted.

        Raises:
            MountCommandUnsupported: The mount's resource has no
                change capability.
        """
        if self._closed:
            raise RuntimeError("watcher is closed")
        entry, root = self._resolve_root(path)
        source = self._get_source(entry, root)
        sub = Subscriber(queue=queue or self._queue_factory(root),
                         root_virtual=root.virtual,
                         recursive=recursive)
        source.subscribers.append(sub)
        try:
            while True:
                try:
                    change = await sub.queue.pop()
                except QueueClosed:
                    return
                yield change
        finally:
            source.subscribers.remove(sub)
            await sub.queue.close()
            if not source.subscribers:
                self._sources.pop((entry.prefix, root.virtual), None)
                if source.task is not None:
                    source.task.cancel()

    async def notify(self, change: ResourceChange) -> None:
        """Inject one precise externally-observed change (push path).

        The consumer's own webhook receiver (e.g. a Nextcloud
        ``webhook_listeners`` endpoint) maps a provider payload to a
        ``ResourceChange`` and calls this. The change is invalidated and
        delivered immediately with no poll, so push latency is bounded
        by the network, not ``poll_interval``. Use ``nudge`` instead
        when the signal carries no path (an imprecise doorbell).

        A running poller may rediscover the same change on its next
        pull; per-path coalescing dampens the duplicate and the model
        is level-triggered, so it is benign.

        Args:
            change (ResourceChange): Precise change; its path is
                reframed to the owning mount before use.
        """
        if self._closed:
            return
        entry = self._registry.mount_for(change.path.virtual)
        framed = replace(change, path=self._frame(entry, change.path.virtual))
        await self._invalidate(entry, framed)
        for source in self._sources.values():
            for sub in source.subscribers:
                if self._matches(sub, framed):
                    await sub.queue.push(framed)

    def nudge(self, path: PathSpec) -> None:
        """Request an immediate pull for sources overlapping ``path``.

        Idempotent and cheap: a consumer-owned webhook receiver or
        queue bridge may call this when a signal carries no exact path.
        When the signal is precise, prefer ``notify``.

        Args:
            path (PathSpec): Dirty path hint.
        """
        hint = "/" + path.virtual.strip("/")
        for source in self._sources.values():
            root = source.root.virtual.rstrip("/") or "/"
            if (hint == root or hint.startswith(root + "/")
                    or root.startswith(hint + "/")):
                source.wake.set()

    async def close(self) -> None:
        """Stop all pollers and close subscriber queues; active watch
        iterators finish cleanly."""
        self._closed = True
        sources = list(self._sources.values())
        self._sources.clear()
        for source in sources:
            if source.task is not None:
                source.task.cancel()
        for source in sources:
            for sub in list(source.subscribers):
                await sub.queue.close()
            if source.task is not None:
                try:
                    await source.task
                except asyncio.CancelledError:
                    # Cancellation is the requested shutdown path.
                    logger.debug("watch source stopped: %s",
                                 source.root.virtual)


def enable_watch(workspace: WatchableWorkspace,
                 *,
                 poll_interval: float = DEFAULT_POLL_INTERVAL,
                 queue_factory: QueueFactory = RAMWatchQueue) -> Watcher:
    """Attach a watch runtime to ``workspace`` and return it.

    Starts nothing: the first ``watch()`` touching a mount lazily
    starts that (mount, root) poller, and the last exit stops it.

    Args:
        workspace (WatchableWorkspace): Workspace to attach to.
        poll_interval (float): Seconds between delta pulls.
        queue_factory (QueueFactory): Builds delivery queues for
            watches that do not supply their own.
    """
    watcher = Watcher(workspace.registry,
                      poll_interval=poll_interval,
                      queue_factory=queue_factory)
    workspace.attach_watch_runtime(watcher)
    return watcher
