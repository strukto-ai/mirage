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

from dataclasses import dataclass

from mirage.resource.base import BaseResource
from mirage.types import MountMode
from mirage.utils.path import resolve_symlinks
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import MountRegistry


@dataclass(frozen=True, slots=True)
class LinkEntry:
    target: str
    mtime: float


class Namespace:
    """Addressing authority: maps virtual paths to their mounts.

    Owns the mount registry and the symlink table (and, in a later phase, the
    attribute overlay). Pure addressing: it resolves a virtual path to its
    mount and backend-relative path, following symlinks and crossing mounts.
    It holds no cache and performs no backend I/O. Op execution and caching
    live in the Dispatcher, which calls this layer to locate the mount.

    Symlinks are stored verbatim as typed: the target string is kept exactly as
    the user wrote it (relative targets are resolved lazily against the link's
    own parent at resolution time), so ``readlink`` is GNU-faithful.
    """

    def __init__(self, registry: MountRegistry) -> None:
        self._registry = registry
        self._symlinks: dict[str, LinkEntry] = {}

    @property
    def registry(self) -> MountRegistry:
        return self._registry

    @property
    def symlinks(self) -> dict[str, LinkEntry]:
        return self._symlinks

    def replace_symlinks(self, entries: dict[str, LinkEntry]) -> None:
        self._symlinks = dict(entries)

    def symlink_targets(self) -> dict[str, str]:
        return {link: entry.target for link, entry in self._symlinks.items()}

    def is_link(self, path: str) -> bool:
        return path in self._symlinks

    def readlink(self, path: str) -> str | None:
        entry = self._symlinks.get(path)
        return entry.target if entry is not None else None

    def symlink(self, link: str, target: str, mtime: float) -> None:
        self._symlinks[link] = LinkEntry(target=target, mtime=mtime)

    def unlink(self, path: str) -> bool:
        if path in self._symlinks:
            del self._symlinks[path]
            return True
        return False

    def rename(self, src: str, dst: str) -> bool:
        entry = self._symlinks.pop(src, None)
        if entry is None:
            return False
        self._symlinks[dst] = entry
        return True

    def resolve(self,
                path: str,
                *,
                follow: bool = True) -> tuple[BaseResource, str, MountMode]:
        """Map a virtual path to ``(resource, resource_path, mode)``.

        Args:
            path (str): virtual path to resolve.
            follow (bool): follow symlinks (the symlink table) before mapping
                the path to its mount.

        Raises:
            CycleError: when symlink resolution exceeds the hop limit (ELOOP).
        """
        if follow and self._symlinks:
            path = resolve_symlinks(path, self.symlink_targets())
        return self._registry.resolve(path)

    def mount_for(self, path: str) -> MountEntry:
        return self._registry.mount_for(path)

    def is_mount_root(self, path: str) -> bool:
        return self._registry.is_mount_root(path)
