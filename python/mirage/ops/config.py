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

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, MountMode

# Ops with lstat semantics: they act on the entry named by the path, so
# no stat surface (dispatch, the ops facade, FUSE) may rewrite their
# operand through the symlink table.
NO_FOLLOW_OPS = frozenset({"unlink", "rename", "rmdir", "symlink", "readlink"})

# Content-writing ops whose completion stamps an observed mtime on the
# namespace node (removals invalidate but must not stamp).
STAMP_WRITE_OPS = frozenset(
    {"write", "write_bytes", "append", "create", "truncate", "mkdir"})


@runtime_checkable
class NamespaceLinks(Protocol):
    """The symlink surface a namespace offers to lower layers.

    The workspace Namespace satisfies this structurally; ops and FUSE
    consume it through this seam so the dependency points downward
    (workspace injects, lower layers never import workspace modules).
    """

    def follow(self, path: str) -> str:
        """Resolve symlink prefixes in ``path`` (identity when none).

        Args:
            path (str): absolute virtual path.
        """
        ...

    def is_link(self, path: str) -> bool:
        """Whether ``path`` names a symlink entry.

        Args:
            path (str): absolute virtual path.
        """
        ...

    def readlink(self, path: str) -> str | None:
        """The stored target for a link path, None when not a link.

        Args:
            path (str): absolute virtual path.
        """
        ...

    def symlink_targets(self) -> dict[str, str]:
        """Every link path to its stored target, the whole table."""
        ...

    def link_stat_at(self, path: str) -> FileStat | None:
        """The link's own stat (lstat), None when ``path`` is not a link.

        Args:
            path (str): absolute virtual path.
        """
        ...

    async def symlink(self, link: str, target: str, mtime: float) -> None:
        """Create or overwrite a symlink entry.

        Args:
            link (str): absolute virtual link path.
            target (str): target as typed (kept verbatim).
            mtime (float): link creation time (epoch seconds).
        """
        ...

    async def unlink(self, path: str) -> bool:
        """Drop a node entry; True when one existed.

        Args:
            path (str): absolute virtual path.
        """
        ...


@dataclass
class OpsMount:
    prefix: str
    resource_type: str
    accessor: Accessor
    index: IndexCacheStore
    mode: MountMode
    ops: list[Any] = field(default_factory=list[Any])
    # Mirrors BaseResource.SIZES_ALWAYS_KNOWN. Read by the fskit mount
    # guard, which cannot serve a resource that sizes files only on read.
    sizes_always_known: bool = False
