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

import copy
from collections.abc import Iterable

from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.record.types import RecordFields, generation_of


class RAMNamespaceStore(NamespaceStore):
    """NamespaceStore held in process memory (the default).

    Durability equals the process lifetime; snapshots remain the only
    persistence. Redis-backed workspaces pass a RedisNamespaceStore
    instead and survive restarts.
    """

    def __init__(self) -> None:
        self._entries: dict[str, RecordFields] = {}

    async def load(self) -> dict[str, RecordFields]:
        return copy.deepcopy(self._entries)

    async def get(self, key: str) -> RecordFields | None:
        return copy.deepcopy(self._entries.get(key))

    async def approval_guarantee(self) -> None:
        return None

    async def set(self, key: str, fields: RecordFields) -> None:
        self._entries[key] = copy.deepcopy(fields)

    async def cas_set(
        self, key: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        if generation_of(self._entries.get(key)) != expected_generation:
            return False
        self._entries[key] = copy.deepcopy(fields)
        return True

    async def delete(self, keys: Iterable[str]) -> None:
        for key in keys:
            self._entries.pop(key, None)

    async def replace_all(self, entries: dict[str, RecordFields]) -> None:
        self._entries = copy.deepcopy(entries)

    async def clear(self) -> None:
        self._entries.clear()

    async def close(self) -> None:
        return None
