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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.find import find as _find
from mirage.core.notion.read import read as _read
from mirage.core.notion.readdir import readdir as _readdir
from mirage.core.notion.stat import stat as _stat
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.notion.prompt import PROMPT, WRITE_PROMPT


class NotionVFS(BaseVFS):
    accessor: NotionAccessor
    name: str = VFSName.NOTION
    caches_reads: bool = True
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: NotionConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = NotionAccessor(config)

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

    async def find(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        **predicates: Any,
    ) -> list[str]:
        return await _find(self.accessor, path, index=index, **predicates)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
