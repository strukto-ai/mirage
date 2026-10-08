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

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.google.client import TokenManager
from mirage.core.gsheets.read import read as _read
from mirage.core.gsheets.readdir import readdir as _readdir
from mirage.core.gsheets.stat import stat as _stat
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.gsheets.config import GSheetsConfig
from mirage.vfs.gsheets.prompt import PROMPT, WRITE_PROMPT


class GSheetsVFS(BaseVFS):
    accessor: GSheetsAccessor
    name: str = VFSName.GSHEETS
    caches_reads: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    # Reads stamp listing metadata; a fresh stat checks Drive by file ID.
    read_revalidatable: bool = True
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    # Every file here is a rendering; there are no stored bytes to read.
    renderers: Mapping[str, str] = MappingProxyType(
        {".gsheet.json": "read_sheet"}
    )

    def __init__(self, config: GSheetsConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = TokenManager(config)
        self.accessor = GSheetsAccessor(self.config, self._token_manager)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await _readdir(self.accessor, path, index)

    async def read_sheet(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        """Render a spreadsheet as the JSON its ``.gsheet.json`` file holds.

        Args:
            path (PathSpec): the file.
            index (IndexCacheStore): the mount's index.
            offset (int): the window's first byte.
            size (int | None): the window's length, None through the end.
        """
        data = await _read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
