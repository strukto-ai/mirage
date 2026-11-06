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

from mirage.resources.base import ResourceStore
from mirage.resources.constants import DEFAULT_SCOPE
from mirage.resources.store import RecordResourceStore
from mirage.resources.types import EntryKind, Fields


class MemoryRecords:
    """Records in a dict, copied in and out so a caller's object never
    aliases one."""

    def __init__(self) -> None:
        self._folders: dict[str, dict[str, Fields]] = {}

    def _folder(self, folder: str) -> dict[str, Fields]:
        return self._folders.setdefault(folder, {})

    async def read(self, folder: str, name: str) -> Fields | None:
        record = self._folder(folder).get(name)
        return None if record is None else copy.deepcopy(record)

    async def write(self, folder: str, name: str, record: Fields) -> None:
        self._folder(folder)[name] = copy.deepcopy(record)

    async def remove(self, folder: str, name: str) -> bool:
        return self._folder(folder).pop(name, None) is not None

    async def names(self, folder: str) -> list[str]:
        return list(self._folder(folder))


class MemorySealer:
    """Sealed values in a dict: for tests, where nothing is kept."""

    def __init__(self) -> None:
        self._values: dict[str, Fields] = {}

    async def read(self, kind: EntryKind, name: str) -> Fields:
        return copy.deepcopy(self._values.get(f"{kind}/{name}", {}))

    async def write(self, kind: EntryKind, name: str, values: Fields) -> None:
        if values:
            self._values[f"{kind}/{name}"] = copy.deepcopy(values)
        else:
            self._values.pop(f"{kind}/{name}", None)

    async def wipe(self, kind: EntryKind, name: str) -> None:
        self._values.pop(f"{kind}/{name}", None)


def memory_resource_store(scope: str = DEFAULT_SCOPE) -> ResourceStore:
    """A store kept in memory, for tests.

    Args:
        scope (str): the scope it serves.
    """
    return RecordResourceStore(scope, MemoryRecords(), MemorySealer())
