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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.search import make_search_op
from mirage.core.langfuse.read import read as _read
from mirage.core.langfuse.readdir import readdir as _readdir
from mirage.core.langfuse.scope import detect_scope
from mirage.core.langfuse.search import SEARCHERS
from mirage.core.langfuse.stat import stat as _stat
from mirage.types import FileStat, JsonValue, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.langfuse.config import LangfuseConfig
from mirage.vfs.langfuse.prompt import PROMPT
from mirage.vfs.types import SearchQuery

_search_fn = make_search_op(detect_scope, SEARCHERS)


class LangfuseVFS(BaseVFS):
    accessor: LangfuseAccessor
    name: str = VFSName.LANGFUSE
    caches_reads: bool = True
    prompt: str = PROMPT

    search_meta: Mapping[str, JsonValue] = MappingProxyType(
        {"grep": {"mode": "regex"}}
    )

    def __init__(self, config: LangfuseConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = LangfuseAccessor(self.config)

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

    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        return await _search_fn(self.accessor, path, query, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
