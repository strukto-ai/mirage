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

from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dev.read import read as dev_read
from mirage.core.dev.stat import stat as dev_stat
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.dev.store import DevStore
from mirage.vfs.ram.ram import RAMVFS


class DevVFS(RAMVFS):
    """``/dev``: a RAM mount whose read and stat know the two synthetic
    character devices, ``null`` and ``zero``.

    Its stream is finite: a command that consumes a whole input reads the
    refusing read, and only the two bounded streaming commands opt into
    the endless source (``commands/builtin/dev``).
    """

    accessor: RAMAccessor
    _store: DevStore
    name: str = VFSName.RAM
    prompt: str = ""
    index_ttl: float = 600
    # Device metadata is synthetic and needs no content fetch.
    sizes_always_known: bool = True

    def __init__(self) -> None:
        super().__init__()
        self._store = DevStore()
        self.accessor = RAMAccessor(self._store)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        return await dev_read(self.accessor, path, index, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await dev_stat(self.accessor, path, index)

    async def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        data = await self.read(path, index)
        if data:
            yield data

    def get_state(self) -> dict[str, Any]:
        return {"type": self.name}

    def load_state(self, state: dict[str, Any]) -> None:
        """Nothing to restore: the devices are synthetic.

        Args:
            state (dict[str, Any]): the payload ``get_state`` produced.
        """

    def allocate_input(self) -> tuple[str, int]:
        return self._store.files.allocate_input()

    def set_input(self, path: str, allocation: int, data: bytes) -> None:
        self._store.files.set_input(path, allocation, data)

    def release_input(self, path: str, allocation: int) -> None:
        if self._store.files.release_input(path, allocation):
            self._store.modified.pop(path[4:], None)
            self._store.attrs.pop(path[4:], None)
