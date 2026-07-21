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

from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from typing import Protocol

from mirage.types import ChangeKind, PathSpec, ResourceChange
from mirage.utils.glob_walk import has_glob
from mirage.utils.path import glob_prefix_match
from mirage.watch.base import WatchRuntime
from mirage.watch.errors import QueueClosed
from mirage.watch.queue.base import QueueFactory, WatchQueue
from mirage.watch.queue.ram import RAMWatchQueue
from mirage.watch.source import Subscriber
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import MountRegistry


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
    """Notify-driven watch runtime: invalidate, then deliver.

    Mirage runs no background loop. Changes enter through ``notify``,
    from whatever detection the consumer runs: a webhook receiver, a
    queue bridge, or their own poll loop over a resource's
    ``delta_hook()`` (see ``integ/watch/run.py`` for the ~10-line
    poller). The one guarantee: cache invalidation for a change
    completes before it reaches any subscriber queue, so a consumer
    reacting to a change always reads fresh content.
    """

    def __init__(self,
                 registry: MountRegistry,
                 queue_factory: QueueFactory = RAMWatchQueue) -> None:
        """Args:
            registry (MountRegistry): Mount table of the workspace.
            queue_factory (QueueFactory): Builds the delivery queue for
                a watch root when the caller does not supply one.
        """
        self._registry = registry
        self._queue_factory = queue_factory
        self._subscribers: list[Subscriber] = []
        self._closed = False

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
        """Whether a change falls inside any of a subscriber's scopes.

        Args:
            sub (Subscriber): Subscriber scopes.
            change (ResourceChange): Candidate change.
        """
        return any(
            self._in_scope(root, sub.recursive, change.path.virtual)
            for root in sub.roots)

    def _in_scope(self, root: str, recursive: bool, virtual: str) -> bool:
        """Whether ``virtual`` falls inside one watch root.

        A glob root (``/nc/data/*.txt``) is matched segment-wise at
        delivery time, so ``*`` does not cross ``/`` and files created
        after the watch started still match; ``recursive`` is ignored
        because the pattern itself defines the depth. A plain root uses
        prefix containment.

        Args:
            root (str): One watch root, literal or glob.
            recursive (bool): Whether descendants beyond direct
                children match a literal root.
            virtual (str): Changed virtual path.
        """
        if has_glob(root):
            return glob_prefix_match(virtual, root)
        root = root.rstrip("/")
        if virtual == root:
            return True
        if not virtual.startswith(root + "/"):
            return False
        if recursive:
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

    async def notify(self, change: ResourceChange) -> None:
        """Inject one externally observed change.

        The single entry point for all detection: a consumer's webhook
        receiver, queue bridge, or poll loop maps its signal to a
        ``ResourceChange`` and calls this. The change's cache entries
        are invalidated first, then it is delivered to every watch
        whose scope matches.

        Args:
            change (ResourceChange): Observed change; its path is
                reframed to the owning mount before use.
        """
        if self._closed:
            return
        entry = self._registry.mount_for(change.path.virtual)
        framed = replace(change, path=self._frame(entry, change.path.virtual))
        await self._invalidate(entry, framed)
        for sub in self._subscribers:
            if self._matches(sub, framed):
                await sub.queue.push(framed)

    async def watch(
            self,
            path: PathSpec | Sequence[PathSpec],
            *,
            recursive: bool = True,
            queue: WatchQueue | None = None) -> AsyncIterator[ResourceChange]:
        """Stream changes under ``path`` until the caller stops
        iterating or the watcher closes.

        Works on any mount: delivery is notify-driven, so no resource
        capability is required to subscribe. Scope matching is done by
        mirage at delivery time, so glob roots need no backend support
        and match files created after the watch started.

        Args:
            path (PathSpec | Sequence[PathSpec]): Watch root or roots;
                each may carry glob segments (``/nc/data/*.txt``) and
                the mount is resolved per root.
            recursive (bool): Deliver descendants beyond direct
                children; ignored for glob roots (the pattern defines
                the depth).
            queue (WatchQueue | None): Delivery queue override; the
                watcher's factory builds one (for the first root) when
                omitted.
        """
        if self._closed:
            raise RuntimeError("watcher is closed")
        paths = [path] if isinstance(path, PathSpec) else list(path)
        if not paths:
            raise ValueError("watch requires at least one path")
        roots = tuple(
            self._frame(self._registry.mount_for(p.virtual), p.virtual)
            for p in paths)
        sub = Subscriber(queue=queue or self._queue_factory(roots[0]),
                         roots=tuple(r.virtual for r in roots),
                         recursive=recursive)
        self._subscribers.append(sub)
        try:
            while True:
                try:
                    change = await sub.queue.pop()
                except QueueClosed:
                    return
                yield change
        finally:
            self._subscribers.remove(sub)
            await sub.queue.close()

    async def close(self) -> None:
        """Close subscriber queues; active watch iterators finish
        cleanly."""
        self._closed = True
        for sub in list(self._subscribers):
            await sub.queue.close()


def enable_watch(workspace: WatchableWorkspace,
                 *,
                 queue_factory: QueueFactory = RAMWatchQueue) -> Watcher:
    """Attach a watch runtime to ``workspace`` and return it.

    The runtime runs nothing in the background; the returned watcher's
    ``notify`` is where the consumer's detection (webhook receiver or
    poll loop over ``resource.delta_hook()``) injects changes.

    Args:
        workspace (WatchableWorkspace): Workspace to attach to.
        queue_factory (QueueFactory): Builds delivery queues for
            watches that do not supply their own.
    """
    watcher = Watcher(workspace.registry, queue_factory=queue_factory)
    workspace.attach_watch_runtime(watcher)
    return watcher
