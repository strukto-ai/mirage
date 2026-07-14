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

from mirage.workspace.mount.namespace.store import NamespaceStore, NodeFields


class RAMNamespaceStore(NamespaceStore):
    """NamespaceStore held in process memory (the default).

    Durability equals the process lifetime; snapshots remain the only
    persistence. Redis-backed workspaces pass a RedisNamespaceStore
    instead and survive restarts.
    """

    def __init__(self) -> None:
        self._entries: dict[str, NodeFields] = {}
        self._user: str | None = None

    async def load(self) -> dict[str, NodeFields]:
        return {path: dict(f) for path, f in self._entries.items()}

    async def set(self, path: str, fields: NodeFields) -> None:
        self._entries[path] = dict(fields)

    async def delete(self, paths: Iterable[str]) -> None:
        for path in paths:
            self._entries.pop(path, None)

    async def replace_all(self, entries: dict[str, NodeFields]) -> None:
        self._entries = {path: dict(f) for path, f in entries.items()}

    async def load_user(self) -> str | None:
        return self._user

    async def set_user(self, user: str) -> None:
        self._user = user

    async def clear(self) -> None:
        self._entries.clear()
        self._user = None

    async def close(self) -> None:
        return None
