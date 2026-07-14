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

from abc import ABC, abstractmethod
from collections.abc import Iterable

NodeFields = dict[str, str | int | float | None]


class NamespaceStore(ABC):
    """Storage seam for the namespace node table.

    Abstract base. The Namespace keeps its node table in memory as the
    working copy (reads stay synchronous on the hot path) and writes every
    mutation through this seam. Subclasses are infra adapters (RAM, Redis);
    everything above (symlinks, the attribute overlay, snapshots) is
    storage-agnostic, mirroring the ObserverStore design.
    """

    @abstractmethod
    async def load(self) -> dict[str, NodeFields]:
        """Read every stored node entry (hydration at first use).

        Returns:
            dict[str, NodeFields]: virtual path to node fields.
        """
        raise NotImplementedError

    @abstractmethod
    async def set(self, path: str, fields: NodeFields) -> None:
        """Upsert one node entry.

        Args:
            path (str): absolute virtual path.
            fields (NodeFields): full field set for the entry.
        """
        raise NotImplementedError

    @abstractmethod
    async def delete(self, paths: Iterable[str]) -> None:
        """Drop node entries.

        Args:
            paths (Iterable[str]): virtual paths to remove.
        """
        raise NotImplementedError

    @abstractmethod
    async def replace_all(self, entries: dict[str, NodeFields]) -> None:
        """Overwrite the whole table (snapshot restore).

        Args:
            entries (dict[str, NodeFields]): the new table.
        """
        raise NotImplementedError

    @abstractmethod
    async def load_user(self) -> str | None:
        """Read the stored workspace user (whoami identity).

        Returns:
            str | None: the stored user, or None when never claimed.
        """
        raise NotImplementedError

    @abstractmethod
    async def set_user(self, user: str) -> None:
        """Store the workspace user (whoami identity).

        Workspace-level metadata, not a node entry: ``replace_all``
        (snapshot restore of the node table) leaves it alone; only
        ``clear`` drops it.

        Args:
            user (str): the workspace user.
        """
        raise NotImplementedError

    @abstractmethod
    async def clear(self) -> None:
        """Delete every stored entry, including the workspace user."""
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        """Release any held connections or handles."""
        raise NotImplementedError
