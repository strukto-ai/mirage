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

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.generic.du import make_walked_du
from mirage.core.onedrive.copy import copy as _copy
from mirage.core.onedrive.create import create as _create
from mirage.core.onedrive.exists import exists as _exists
from mirage.core.onedrive.find import find as _find
from mirage.core.onedrive.mkdir import mkdir as _mkdir
from mirage.core.onedrive.read import read as _read
from mirage.core.onedrive.readdir import readdir as _readdir
from mirage.core.onedrive.rename import rename as _rename
from mirage.core.onedrive.rm import rm_r as _rm_r
from mirage.core.onedrive.rmdir import rmdir as _rmdir
from mirage.core.onedrive.stat import stat as _stat
from mirage.core.onedrive.stream import read_stream as _read_stream
from mirage.core.onedrive.truncate import truncate as _truncate
from mirage.core.onedrive.unlink import unlink as _unlink
from mirage.core.onedrive.watch import build_delta_hook
from mirage.core.onedrive.write import write as _write
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.onedrive.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook

_du = make_walked_du(_stat, _readdir)


class OneDriveVFS(BaseVFS):
    accessor: OneDriveAccessor
    name: str = VFSName.ONEDRIVE
    caches_reads: bool = True
    # Graph driveItems carry an exact byte `size` for every file in both
    # listings and item gets; folders (including the root) report None
    # with the aggregate storage number in extra.
    sizes_always_known: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    supports_snapshot: bool = True
    # stat and every read that can fill the cache stamp the item's cTag,
    # the read taking it before the bytes, so the gate compares like with
    # like.
    read_revalidatable: bool = True

    reads_ranges: bool = True

    def __init__(self, config: OneDriveConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = OneDriveAccessor(self.config)

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

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, index)

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
        return await _du.size(self.accessor, path, index)

    async def du_entries(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> DuEntries:
        return await _du.entries(self.accessor, path, index)

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

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
