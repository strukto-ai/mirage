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

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from mirage.types import Delta, PathSpec, ResourceChange
from mirage.watch.queue.base import WatchQueue


class DeltaHook(Protocol):
    """Checkpointed delta pull for one watch root.

    Contract: ``pull`` reads the backend directly and must not read
    through mirage's caches; a hook that consults the read/index cache
    compares the cache to itself and detects nothing. A baseline pull
    (``checkpoint=None``) establishes state and returns no changes.
    """

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root (mount-virtual path).
            checkpoint (str | None): Opaque state returned by the
                previous pull, or None for a baseline.
        """
        ...


@runtime_checkable
class SupportsChanges(Protocol):
    """Optional resource capability: native change detection.

    A resource that implements this returns a hook whose detector is
    cheaper or more precise than a generic listing diff (Nextcloud:
    WebDAV listing walk with ETag/mtime detectors).
    """

    def delta_hook(self) -> DeltaHook:
        """Build the resource's delta hook (stateless; per-watch
        checkpoints are held by the caller)."""
        ...


class WatchRuntime(Protocol):
    """What ``Workspace.watch`` delegates to.

    Implemented by ``mirage.watch.Watcher``; the workspace only holds
    this protocol so the dependency arrow stays watch -> workspace.
    """

    def watch(
            self,
            path: PathSpec,
            *,
            recursive: bool = True,
            queue: WatchQueue | None = None) -> AsyncIterator[ResourceChange]:
        """Stream changes under ``path``; see ``Watcher.watch``."""
        ...

    async def notify(self, change: ResourceChange) -> None:
        """Inject a precise change from a push source; see
        ``Watcher.notify``."""
        ...

    def nudge(self, path: PathSpec) -> None:
        """Request an immediate pull for sources covering ``path``."""
        ...

    async def close(self) -> None:
        """Stop all pollers and release queues."""
        ...
