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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.qdrant.tree import SEARCH, read, readdir, stat
from mirage.errors.fs import enotsup
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.qdrant.config import QdrantConfig
from mirage.vfs.qdrant.prompt import PROMPT
from mirage.vfs.types import SearchQuery


class QdrantVFS(BaseVFS):
    accessor: QdrantAccessor
    name: str = VFSName.QDRANT
    # readdir seeds exact rendered sizes from the scroll payloads and stat
    # falls back to rendering the row itself, so sizes are exact either way.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = False

    def __init__(self, config: QdrantConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = QdrantAccessor(self.config)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await stat(self.accessor, path, index)

    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        return await SEARCH.search(self.accessor, path, query, index)

    async def search_many(
        self,
        paths: list[PathSpec],
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        many = SEARCH.search_many
        if many is None:
            raise enotsup(self.name, "search", paths[0])
        return await many(self.accessor, paths, query, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
