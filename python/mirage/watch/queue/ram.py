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
from datetime import datetime, timezone

from mirage.types import FileChangeKind, FileEvent, OverflowPolicy, PathSpec
from mirage.watch.constants import DEFAULT_MAX_PENDING
from mirage.watch.errors import QueueClosed, QueueOverflowError


class RAMWatchQueue:
    """In-memory coalescing queue: one pending change per path.

    Repeated changes to one path merge with level-triggered semantics
    (latest state wins), so pending size is bounded by distinct dirty
    paths, not event volume:

    - CREATE then UPDATE stays CREATE (the consumer never saw it);
    - CREATE then DELETE cancels out;
    - UPDATE then DELETE becomes DELETE;
    - DELETE then CREATE becomes UPDATE (the path was replaced).

    On overflow the default policy collapses everything to one UNKNOWN
    change at the watch root: precision degrades to "re-inventory this
    subtree", dirtiness is never lost.
    """

    def __init__(
            self,
            root: PathSpec,
            max_pending: int = DEFAULT_MAX_PENDING,
            on_overflow: OverflowPolicy = OverflowPolicy.COLLAPSE) -> None:
        """Args:
            root (PathSpec): Watch root, used as the path of the
                collapse UNKNOWN change.
            max_pending (int): Cap on distinct pending paths.
            on_overflow (OverflowPolicy): Behaviour when the cap is
                exceeded.
        """
        self._root = root
        self._max_pending = max_pending
        self._on_overflow = on_overflow
        self._pending: dict[str, FileEvent] = {}
        self._overflowed = False
        self._closed = False
        self._ready = asyncio.Event()

    def _merge(self, old: FileEvent | None,
               new: FileEvent) -> FileEvent | None:
        """Level-triggered merge of a pending change with a new one.

        Args:
            old (FileEvent | None): Currently pending change.
            new (FileEvent): Newly observed change.

        Returns:
            FileEvent | None: Replacement pending change, or None
            when the pair cancels out (CREATE then DELETE).
        """
        if old is None:
            return new
        if old.kind is FileChangeKind.CREATE:
            if new.kind is FileChangeKind.DELETE:
                return None
            return FileEvent(kind=FileChangeKind.CREATE,
                             path=new.path,
                             timestamp=new.timestamp,
                             previous_path=new.previous_path,
                             metadata=new.metadata)
        if old.kind is FileChangeKind.DELETE \
                and new.kind is FileChangeKind.CREATE:
            return FileEvent(kind=FileChangeKind.UPDATE,
                             path=new.path,
                             timestamp=new.timestamp,
                             previous_path=new.previous_path,
                             metadata=new.metadata)
        return new

    async def push(self, change: FileEvent) -> None:
        """Merge ``change`` into the pending map; apply the overflow
        policy when the cap is exceeded.

        Args:
            change (FileEvent): Change to deliver.
        """
        if self._closed:
            return
        key = change.path.virtual
        merged = self._merge(self._pending.pop(key, None), change)
        if merged is not None:
            self._pending[key] = merged
        if len(self._pending) > self._max_pending:
            if self._on_overflow is OverflowPolicy.DROP_OLDEST:
                oldest = next(iter(self._pending))
                del self._pending[oldest]
            elif self._on_overflow is OverflowPolicy.ERROR:
                self._pending.clear()
                self._overflowed = True
            else:
                self._pending.clear()
                self._pending[self._root.virtual] = FileEvent(
                    kind=FileChangeKind.UNKNOWN,
                    path=self._root,
                    timestamp=datetime.now(timezone.utc))
        if self._pending or self._overflowed:
            self._ready.set()

    async def pop(self) -> FileEvent:
        """Wait for and return the next pending change.

        Raises:
            QueueOverflowError: The queue overflowed under
                ``OverflowPolicy.ERROR`` since the last pop.
            QueueClosed: The queue was closed while waiting.
        """
        # Condition-wait loop, not a busy spin: the await at the bottom
        # suspends until push()/close() sets _ready, and each wake
        # re-checks state exactly once.
        while True:
            if self._closed:
                raise QueueClosed(self._root.virtual)
            if self._overflowed:
                self._overflowed = False
                if not self._pending:
                    self._ready.clear()
                raise QueueOverflowError(
                    f"watch queue for {self._root.virtual} exceeded "
                    f"{self._max_pending} pending changes")
            if self._pending:
                key = next(iter(self._pending))
                change = self._pending.pop(key)
                if not self._pending:
                    self._ready.clear()
                return change
            self._ready.clear()
            await self._ready.wait()

    async def pending(self) -> int | None:
        """Exact number of pending changes."""
        return len(self._pending)

    async def clear(self) -> None:
        """Drop all pending changes."""
        self._pending.clear()
        self._overflowed = False
        self._ready.clear()

    async def close(self) -> None:
        """Drop pending changes and wake any blocked ``pop``."""
        self._closed = True
        self._pending.clear()
        self._overflowed = False
        self._ready.set()
