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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.copy import copy as _copy
from mirage.core.box.create import create as _create
from mirage.core.box.exists import exists as _exists
from mirage.core.box.mkdir import mkdir as _mkdir
from mirage.core.box.read import read as _read
from mirage.core.box.read import read_stream as _stream
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.rename import rename as _rename
from mirage.core.box.rmdir import rm_r as _rm_r
from mirage.core.box.rmdir import rmdir as _rmdir
from mirage.core.box.search import narrow_paths
from mirage.core.box.stat import stat as _stat
from mirage.core.box.truncate import truncate as _truncate
from mirage.core.box.unlink import unlink as _unlink
from mirage.core.box.watch import build_delta_hook
from mirage.core.box.write import write as _write
from mirage.core.generic.du import make_walked_du
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.box.config import BoxConfig
from mirage.vfs.box.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook

_du = make_walked_du(_stat, _readdir)


class BoxVFS(BaseVFS):
    accessor: BoxAccessor
    name: str = VFSName.BOX
    caches_reads: bool = True
    index_ttl: float = 86_400
    # Box item listings carry an exact byte `size` for every file (0
    # included); sizeless weblinks are filtered out of listings.
    sizes_always_known: bool = True
    # stat and every whole read stamp the file's sha1, which a listing row
    # and GET /files/{id} carry. A download names no version, so a read
    # checks its bytes against the row it resolved through.
    read_revalidatable: bool = True
    prompt: str = PROMPT

    reads_ranges: bool = True

    def __init__(self, config: BoxConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = BoxTokenManager(config)
        self.accessor = BoxAccessor(self.config, self._token_manager)

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
        return _stream(self.accessor, path, index)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

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

    async def narrow_paths(
        self, query: str, paths: list[PathSpec]
    ) -> list[PathSpec] | None:
        return await narrow_paths(self.accessor, query, paths)

    def content_search_enabled(self) -> bool:
        return self.accessor.config.content_search

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
