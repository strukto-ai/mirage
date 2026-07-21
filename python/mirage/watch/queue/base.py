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

from collections.abc import Callable
from typing import Protocol

from mirage.types import FileEvent, PathSpec


class WatchQueue(Protocol):
    """Delivery queue between the poller and one watch consumer.

    Implementations own coalescing and overflow policy. The default
    ``RAMWatchQueue`` merges changes per path (level-triggered, latest
    state wins) and collapses to one UNKNOWN change on overflow; a
    journal-style implementation that keeps every event is equally
    valid. ``push`` may perform I/O but must never wait on consumer
    progress: the poller's checkpoint has to keep advancing regardless
    of consumer speed.
    """

    async def push(self, change: FileEvent) -> None:
        """Enqueue a change; never blocks on consumer progress.

        Args:
            change (FileEvent): Change to deliver.
        """
        ...

    async def pop(self) -> FileEvent:
        """Wait until a change is pending and return it.

        Raises:
            QueueOverflowError: The queue overflowed under
                ``OverflowPolicy.ERROR`` since the last pop.
            QueueClosed: The queue was closed while waiting.
        """
        ...

    async def pending(self) -> int | None:
        """Number of changes waiting, or None when only approximate
        counts are available (remote queues)."""
        ...

    async def clear(self) -> None:
        """Drop all pending changes."""
        ...

    async def close(self) -> None:
        """Release queue resources; pending changes are dropped."""
        ...


QueueFactory = Callable[[PathSpec], WatchQueue]
