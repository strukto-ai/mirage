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

from collections.abc import Callable

from mirage.accessor.document import DocumentAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.document.read import read as document_read
from mirage.core.document.readdir import readdir as document_readdir
from mirage.core.document.stat import stat as document_stat
from mirage.types import FileStat, PathSpec
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS


class DocumentVFS(BaseVFS):
    """A live Markdown file; no backend storage or content cache."""

    accessor: DocumentAccessor

    def __init__(
        self, name: str, render: Callable[[], str], kind: str
    ) -> None:
        super().__init__(
            name="document",
            accessor=DocumentAccessor(name, render),
            sizes_always_known=True,
        )
        self.kind = kind
        self.global_view = False
        self.sessions: dict[str, float] = {}

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await document_readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await document_read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await document_stat(self.accessor, path, index)
