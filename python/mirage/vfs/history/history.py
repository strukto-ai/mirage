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

from mirage.accessor.history import HistoryAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.history.find import find
from mirage.core.history.read import read as _read
from mirage.core.history.readdir import readdir as _readdir
from mirage.core.history.stat import stat as _stat
from mirage.types import FileStat, PathSpec
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS

HISTORY_PREFIX = "/.bash_history"


class HistoryViewVFS(BaseVFS):
    """Read-only view VFS backing the /.bash_history mount.

    Renders GNU views from the workspace's hidden recorder on every
    read; holds no storage of its own.

    Args:
        observer (Observer): The workspace's hidden recorder.
    """

    accessor: HistoryAccessor

    name = "history"
    # The view renders from in-memory events, so stat() sizes it by
    # rendering: cheap, no network, and never None.
    sizes_always_known: bool = True

    def __init__(self, observer) -> None:
        super().__init__()
        self.observer = observer
        self.accessor = HistoryAccessor(observer)

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
        return await find(self.accessor, path, **predicates)

    def get_state(self) -> dict[str, Any]:
        return {"type": self.name}
