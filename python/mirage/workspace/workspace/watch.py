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

from mirage.types import FileEvent, PathSpec
from mirage.watch import Watcher
from mirage.workspace.mount import MountRegistry


class WatchDelegate(Protocol):
    """What ``Workspace.watch`` needs from an attached watch runtime.

    ``mirage.watch.Watcher`` satisfies this structurally.
    """

    def watch(self,
              path: PathSpec | Sequence[PathSpec]) -> AsyncIterator[FileEvent]:
        ...

    async def notify(self, change: FileEvent) -> None:
        ...

    async def close(self) -> None:
        ...


class WatchManager:
    """Holds the watch runtime and attaches it lazily.

    Nothing is constructed until something is actually watched or
    notified, so an idle workspace carries no watch state. The
    workspace keeps the public surface and the closed check; swapping
    or wrapping the runtime is a change here.

    Args:
        registry (MountRegistry): mounts the default watcher observes.
    """

    def __init__(self, registry: MountRegistry) -> None:
        self._registry = registry
        self._runtime: WatchDelegate | None = None

    @property
    def runtime(self) -> WatchDelegate | None:
        return self._runtime

    def attach(self, runtime: WatchDelegate) -> None:
        """Install the runtime ``watch`` delegates to.

        Args:
            runtime (WatchDelegate): Runtime to attach.

        Raises:
            RuntimeError: A runtime is already attached.
        """
        if self._runtime is not None:
            raise RuntimeError(
                "watch runtime already attached: detach_watch_runtime "
                "first, or attach before the first watch()/notify()")
        self._runtime = runtime

    async def detach(self) -> None:
        """Close and drop the attached runtime, if any.

        Closing it closes every subscriber queue, so active ``watch``
        iterators finish cleanly. A no-op when nothing is attached.
        """
        if self._runtime is not None:
            await self._runtime.close()
            self._runtime = None

    def delegate(self) -> WatchDelegate:
        """The attached runtime, lazily creating the default one."""
        if self._runtime is None:
            self._runtime = Watcher(self._registry)
        return self._runtime

    def watch(self, specs: Sequence[PathSpec]) -> AsyncIterator[FileEvent]:
        """Stream changes under the given roots.

        Args:
            specs (Sequence[PathSpec]): Watch roots, already coerced.
        """
        return self.delegate().watch(list(specs))

    async def notify(self, change: FileEvent) -> None:
        """Deliver one observed change to the runtime.

        Args:
            change (FileEvent): Observed change.
        """
        await self.delegate().notify(change)
