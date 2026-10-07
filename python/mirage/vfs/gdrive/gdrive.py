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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gdrive.copy import copy as _copy
from mirage.core.gdrive.create import create as _create
from mirage.core.gdrive.du import entries as _du_entries
from mirage.core.gdrive.du import size as _du_size
from mirage.core.gdrive.exists import exists as _exists
from mirage.core.gdrive.find import find as _find
from mirage.core.gdrive.mkdir import mkdir as _mkdir
from mirage.core.gdrive.read import read as _read
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.core.gdrive.rename import rename as _rename
from mirage.core.gdrive.rm import rm_r as _rm_r
from mirage.core.gdrive.rmdir import rmdir as _rmdir
from mirage.core.gdrive.stat import stat as _stat
from mirage.core.gdrive.truncate import truncate as _truncate
from mirage.core.gdrive.unlink import unlink as _unlink
from mirage.core.gdrive.watch import build_delta_hook
from mirage.core.gdrive.write import write as _write
from mirage.core.google.client import TokenManager
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.gdrive.config import GoogleDriveConfig
from mirage.vfs.gdrive.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook


class GoogleDriveVFS(BaseVFS):
    accessor: GDriveAccessor
    name: str = VFSName.GDRIVE
    caches_reads: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    supports_snapshot: bool = True
    read_revalidatable: bool = True

    reads_ranges: bool = True

    def __init__(self, config: GoogleDriveConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = TokenManager(config)
        self.accessor = GDriveAccessor(self.config, self._token_manager)

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
        if not offset and size is None:
            return await _read(self.accessor, path, index)
        return await _read(self.accessor, path, index, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def find(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        **predicates: Any,
    ) -> list[str]:
        return await _find(self.accessor, path, index=index, **predicates)

    async def du_size(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> int:
        return await _du_size(self.accessor, path, index)

    async def du_entries(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> DuEntries:
        return await _du_entries(self.accessor, path, index)

    async def write(self, path: PathSpec, data: bytes) -> None:
        await _write(self.accessor, path, data)

    async def create(self, path: PathSpec) -> None:
        await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        await _rmdir(self.accessor, path, index)

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await _rename(self.accessor, src, dst)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await _truncate(self.accessor, path, length, no_create)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
