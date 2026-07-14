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

from collections.abc import Iterable
from typing import Protocol, runtime_checkable

NodeFields = dict[str, str | int | float | None]


@runtime_checkable
class NamespaceStore(Protocol):
    """Storage seam for the namespace node table.

    The Namespace keeps its node table in memory as the working copy
    (reads stay synchronous on the hot path) and writes every mutation
    through this seam. Implementations are infra adapters (RAM, Redis);
    everything above (symlinks, the attribute overlay, snapshots) is
    storage-agnostic, mirroring the ObserverStore design.
    """

    async def load(self) -> dict[str, NodeFields]:
        """Read every stored node entry (hydration at first use).

        Returns:
            dict[str, NodeFields]: virtual path to node fields.
        """
        ...

    async def set(self, path: str, fields: NodeFields) -> None:
        """Upsert one node entry.

        Args:
            path (str): absolute virtual path.
            fields (NodeFields): full field set for the entry.
        """
        ...

    async def delete(self, paths: Iterable[str]) -> None:
        """Drop node entries.

        Args:
            paths (Iterable[str]): virtual paths to remove.
        """
        ...

    async def replace_all(self, entries: dict[str, NodeFields]) -> None:
        """Overwrite the whole table (snapshot restore).

        Args:
            entries (dict[str, NodeFields]): the new table.
        """
        ...

    async def clear(self) -> None:
        """Delete every stored entry."""
        ...

    async def close(self) -> None:
        """Release any held connections or handles."""
        ...


class RAMNamespaceStore:
    """NamespaceStore held in process memory (the default).

    Durability equals the process lifetime; snapshots remain the only
    persistence. Redis-backed workspaces pass a RedisNamespaceStore
    instead and survive restarts.
    """

    def __init__(self) -> None:
        self._entries: dict[str, NodeFields] = {}

    async def load(self) -> dict[str, NodeFields]:
        return {path: dict(f) for path, f in self._entries.items()}

    async def set(self, path: str, fields: NodeFields) -> None:
        self._entries[path] = dict(fields)

    async def delete(self, paths: Iterable[str]) -> None:
        for path in paths:
            self._entries.pop(path, None)

    async def replace_all(self, entries: dict[str, NodeFields]) -> None:
        self._entries = {path: dict(f) for path, f in entries.items()}

    async def clear(self) -> None:
        self._entries.clear()

    async def close(self) -> None:
        return None
