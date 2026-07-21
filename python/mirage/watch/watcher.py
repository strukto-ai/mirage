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

from mirage.types import FileChangeKind, FileEvent, PathSpec
from mirage.utils.glob_walk import has_glob
from mirage.utils.path import glob_prefix_match
from mirage.watch.base import WatchMount, WatchRegistry
from mirage.watch.errors import QueueClosed
from mirage.watch.queue.base import QueueFactory, WatchQueue
from mirage.watch.queue.ram import RAMWatchQueue
from mirage.watch.source import Subscriber


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
                 registry: WatchRegistry,
                 queue_factory: QueueFactory = RAMWatchQueue) -> None:
        """Args:
            registry (WatchRegistry): Mount table of the workspace.
            queue_factory (QueueFactory): Builds the delivery queue for
                a watch root when the caller does not supply one.
        """
        self._registry = registry
        self._queue_factory = queue_factory
        self._subscribers: list[Subscriber] = []
        self._closed = False

    def _frame(self, entry: WatchMount, virtual: str) -> PathSpec:
        """Rebuild a PathSpec with mount-relative framing.

        The caller-supplied virtual path may carry any resource_path;
        cache invalidation needs the real mount-relative one, so it is
        recomputed from the mount prefix.

        Args:
            entry (WatchMount): Mount owning the path.
            virtual (str): Workspace-virtual path.
        """
        norm = "/" + virtual.strip("/")
        resource_path = norm[len(entry.prefix):] if norm.startswith(
            entry.prefix) else ""
        return PathSpec.from_str_path(norm, resource_path=resource_path)

    def _matches(self, sub: Subscriber, change: FileEvent) -> bool:
        """Whether a change falls inside any of a subscriber's scopes.

        Args:
            sub (Subscriber): Subscriber scopes.
            change (FileEvent): Candidate change.
        """
        return any(
            self._in_scope(root, change.path.virtual) for root in sub.roots)

    def _in_scope(self, root: str, virtual: str) -> bool:
        """Whether ``virtual`` falls inside one watch root.

        The root's shape defines the depth, GNU shell glob style. A
        literal directory root is the whole subtree; glob roots are
        matched segment-wise at delivery time (``*`` does not cross
        ``/``, and files created after the watch started still match):

        - no trailing slash (``/nc/data/*``, ``/nc/data/*.txt``):
          the matched entries themselves — exact depth, no descent
          (the glob spelling of a shallow watch);
        - trailing slash (``/nc/data/*/``, ``/nc/data/*/abc/``):
          directories, scoping everything strictly inside them
          (mirroring GNU ``*/`` matching only directories, which
          walkers then descend into).

        Args:
            root (str): One watch root, literal or glob.
            virtual (str): Changed virtual path.
        """
        if has_glob(root):
            pat = root.rstrip("/")
            if not glob_prefix_match(virtual, pat):
                return False
            path_depth = len(virtual.strip("/").split("/"))
            pat_depth = len(pat.strip("/").split("/"))
            if root.endswith("/"):
                return path_depth > pat_depth
            return path_depth == pat_depth
        root = root.rstrip("/")
        return virtual == root or virtual.startswith(root + "/")

    def _ancestors(self, entry: WatchMount, virtual: str) -> list[PathSpec]:
        """Framed ancestor directories of ``virtual`` below the mount
        root, nearest first.

        Args:
            entry (WatchMount): Mount owning the path.
            virtual (str): Workspace-virtual path of the change.
        """
        prefix = entry.prefix.rstrip("/")
        specs: list[PathSpec] = []
        current = virtual.rstrip("/")
        while True:
            current = current.rsplit("/", 1)[0]
            if len(current) <= len(prefix):
                return specs
            specs.append(self._frame(entry, current))

    async def _evict(self, entry: WatchMount, path: PathSpec,
                     unlink: bool) -> None:
        """Evict one path and every cached ancestor listing above it.

        The whole ancestor chain is invalidated, not just the path: an
        external change is often the only signal mirage gets, and a
        nested create/delete implies intermediate directories appeared
        or vanished with it, so every cached listing up to the mount
        root may be stale (a consumer forwarding only file events from
        a Nextcloud webhook hits exactly this).

        Args:
            entry (WatchMount): Mount owning the path.
            path (PathSpec): Framed path that is now stale.
            unlink (bool): Whether the path itself disappeared.
        """
        manager = entry.cache_manager
        if manager is None:
            return
        if unlink:
            await manager.invalidate_after_unlink(path)
        else:
            await manager.invalidate_after_write(path)
        for ancestor in self._ancestors(entry, path.virtual):
            await manager.invalidate_after_write(ancestor)

    async def _invalidate(self, entry: WatchMount, change: FileEvent) -> None:
        """Evict cache for one change before it is delivered.

        A MOVE evicts both sides: the target as a write and the
        vacated ``previous_path`` as an unlink (on its own mount), so
        neither the old nor the new location can serve stale bytes.

        Args:
            entry (WatchMount): Mount owning the change path.
            change (FileEvent): Change whose path is now stale.
        """
        await self._evict(entry, change.path, change.kind
                          is FileChangeKind.DELETE)
        if change.kind is FileChangeKind.MOVE \
                and change.previous_path is not None:
            prev_virtual = change.previous_path.virtual
            prev_entry = self._registry.mount_for(prev_virtual)
            await self._evict(prev_entry, self._frame(prev_entry,
                                                      prev_virtual), True)

    async def notify(self, change: FileEvent) -> None:
        """Inject one externally observed change.

        The single entry point for all detection: a consumer's webhook
        receiver, queue bridge, or poll loop maps its signal to a
        ``FileEvent`` and calls this. The change's cache entries
        are invalidated first, then it is delivered to every watch
        whose scope matches.

        Args:
            change (FileEvent): Observed change; its path is
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
            queue: WatchQueue | None = None) -> AsyncIterator[FileEvent]:
        """Stream changes under ``path`` until the caller stops
        iterating or the watcher closes.

        Works on any mount: delivery is notify-driven, so no resource
        capability is required to subscribe. Scope matching is done by
        mirage at delivery time, so glob roots need no backend support
        and match files created after the watch started. The root's
        shape defines the depth: a literal directory is its whole
        subtree, ``/dir/*`` is the entries at that level (shallow),
        ``/dir/*/`` is everything inside child directories (see
        ``_in_scope``).

        Args:
            path (PathSpec | Sequence[PathSpec]): Watch root or roots;
                each may carry glob segments (``/nc/data/*.txt``) and
                the mount is resolved per root.
            queue (WatchQueue | None): Delivery queue override; the
                watcher's factory builds one over all roots when
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
        # Scope strings keep a trailing slash: /nc/data/*/ (inside
        # matched dirs) and /nc/data/* (the entries themselves) are
        # different scopes, while _frame normalizes it away.
        scopes = tuple(
            "/" + p.virtual.strip("/") +
            ("/" if p.virtual.endswith("/") and p.virtual.strip("/") else "")
            for p in paths)
        sub = Subscriber(queue=queue or self._queue_factory(roots),
                         roots=scopes)
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
