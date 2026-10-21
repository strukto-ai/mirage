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
from typing import Protocol

from mirage.cache.manager import CacheManager
from mirage.types import Delta, FileEvent, PathSpec


class EventMount(Protocol):
    """What the event runtime needs from one mount entry.

    ``mirage.workspace.mount.mount.MountEntry`` satisfies this
    structurally; depending on the protocol keeps the events package
    from importing the workspace package at all, so the dependency
    arrow can point workspace -> events without any cycle.
    """

    @property
    def prefix(self) -> str: ...

    @property
    def cache_manager(self) -> CacheManager | None: ...


class EventRegistry(Protocol):
    """What the event runtime needs from the mount table.

    ``mirage.workspace.mount.registry.MountRegistry`` satisfies this
    structurally.
    """

    def mount_for(self, path: str) -> EventMount: ...


class DeltaHook(Protocol):
    """Checkpointed delta pull for one event root, run when the backend
    pings.

    Contract: ``pull`` reads the backend directly and must not read
    through mirage's caches; a hook that consults the read/index cache
    compares the cache to itself and detects nothing. A baseline pull
    (``checkpoint=None``) establishes state and returns no changes.
    """

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Event root (mount-virtual path).
            checkpoint (str | None): Opaque state returned by the
                previous pull, or None for a baseline.
        """
        ...


class EventRuntime(Protocol):
    """What ``Workspace.events`` delegates to.

    Implemented by ``mirage.events.EventHub``; the workspace only holds
    this protocol so the dependency arrow stays workspace -> events.
    """

    def events(
        self, path: PathSpec | Sequence[PathSpec]
    ) -> AsyncIterator[FileEvent]:
        """Stream changes under ``path``; see ``EventHub.events``."""
        ...

    async def notify(self, change: FileEvent) -> None:
        """Inject an externally observed change; see
        ``EventHub.notify``."""
        ...

    async def close(self) -> None:
        """Release subscriber queues."""
        ...
