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

from mirage.resource.base import BaseResource
from mirage.types import MountMode
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import MountRegistry


class Namespace:
    """Addressing authority: maps virtual paths to their mounts.

    Owns the mount registry (and, in later phases, the symlink and attribute
    tables). Pure addressing: it resolves a virtual path to its mount and
    backend-relative path, following symlinks and crossing mounts. It holds no
    cache and performs no backend I/O. Op execution and caching live in the
    Dispatcher, which calls this layer to locate the mount.

    The ``follow`` argument on ``resolve`` is the seam for symlink-following;
    it is a no-op until the symlink table lands.
    """

    def __init__(self, registry: MountRegistry) -> None:
        self._registry = registry

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

    def mount_for(self, path: str) -> MountEntry:
        return self._registry.mount_for(path)
