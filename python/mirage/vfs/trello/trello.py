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

from typing import Any

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.trello.read import read as _read
from mirage.core.trello.readdir import readdir as _readdir
from mirage.core.trello.stat import stat as _stat
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.trello.config import TrelloConfig
from mirage.vfs.trello.prompt import PROMPT, WRITE_PROMPT


class TrelloVFS(BaseVFS):
    accessor: TrelloAccessor
    name: str = VFSName.TRELLO
    caches_reads: bool = True
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: TrelloConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = TrelloAccessor(self.config)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await _readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await _read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
