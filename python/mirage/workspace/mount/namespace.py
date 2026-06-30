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

from typing import Any

from mirage.io import IOResult
from mirage.resource.base import BaseResource
from mirage.types import ConsistencyPolicy, FileStat, MountMode, PathSpec
from mirage.workspace.dispatcher import Dispatcher
from mirage.workspace.mount.registry import MountRegistry


class Namespace:
    """Single front for path resolution and VFS op dispatch.

    Owns the mount registry and the op dispatcher (cache read-through plus
    post-write invalidation). The rest of the workspace talks to storage
    through this one object instead of reaching the registry, the dispatcher,
    and the ops layer separately: ``resolve`` maps a virtual path to its mount,
    and ``dispatch``/``stat``/``readdir`` route a VFS op to the owning mount.

    The ``follow`` argument on ``resolve`` is the seam for symlink-following;
    it is a no-op until the symlink table lands in a later phase.
    """

    def __init__(self, registry: MountRegistry, cache,
                 consistency: ConsistencyPolicy) -> None:
        self._registry = registry
        self._dispatcher = Dispatcher(registry, cache, consistency)

    @property
    def registry(self) -> MountRegistry:
        return self._registry

    def resolve(self,
                path: str,
                *,
                follow: bool = True) -> tuple[BaseResource, str, MountMode]:
        """Map a virtual path to ``(resource, resource_path, mode)``.

        Args:
            path (str): virtual path to resolve.
            follow (bool): follow symlinks when resolving. No-op until the
                symlink table lands.
        """
        return self._registry.resolve(path)

    async def dispatch(self, op: str, path: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        return await self._dispatcher.dispatch(op, path, **kwargs)

    async def stat(self, path: str) -> FileStat:
        return await self._dispatcher.stat(path)

    async def readdir(self, path: str) -> list[str]:
        return await self._dispatcher.readdir(path)

    async def apply_io(self, io: IOResult) -> None:
        await self._dispatcher.apply_io(io)

    async def invalidate_after_write_by_path(self, path: str) -> None:
        await self._dispatcher.invalidate_after_write_by_path(path)
