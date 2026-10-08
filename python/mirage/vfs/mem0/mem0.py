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

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mem0.read import read as _read
from mirage.core.mem0.read import read_stream as _read_stream
from mirage.core.mem0.readdir import readdir as _readdir
from mirage.core.mem0.search import search_many, search_resource
from mirage.core.mem0.stat import stat as _stat
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.mem0.config import Mem0Config
from mirage.vfs.mem0.prompt import PROMPT
from mirage.vfs.types import SearchQuery


class Mem0VFS(BaseVFS):
    accessor: Mem0Accessor
    name: str = VFSName.MEM0
    caches_reads: bool = True
    # readdir and stat store the rendered JSON's byte length and read
    # serves those same bytes, so sizes are exact by construction.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = False

    def __init__(self, config: Mem0Config) -> None:
        super().__init__()
        self.config = config
        self.accessor = Mem0Accessor(self.config)

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

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, index)

    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        return await search_resource(self.accessor, path, query, index)

    async def search_many(
        self,
        paths: list[PathSpec],
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        return await search_many(self.accessor, paths, query, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
