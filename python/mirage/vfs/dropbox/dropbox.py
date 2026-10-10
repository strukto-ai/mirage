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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.core.dropbox.copy import copy as _copy
from mirage.core.dropbox.create import create as _create
from mirage.core.dropbox.exists import exists as _exists
from mirage.core.dropbox.mkdir import mkdir as _mkdir
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.read import read_stream as _stream
from mirage.core.dropbox.readdir import readdir as _readdir
from mirage.core.dropbox.rename import rename as _rename
from mirage.core.dropbox.rm import rm_r as _rm_r
from mirage.core.dropbox.rmdir import rmdir as _rmdir
from mirage.core.dropbox.search import files_containing as _files_containing
from mirage.core.dropbox.stat import stat as _stat
from mirage.core.dropbox.unlink import unlink as _unlink
from mirage.core.dropbox.watch import build_delta_hook
from mirage.core.dropbox.write import write as _write
from mirage.core.generic.du import make_walked_du
from mirage.core.generic.rewrite import truncate_by_rewrite
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.dropbox.config import DropboxConfig
from mirage.vfs.dropbox.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook

_du = make_walked_du(_stat, _readdir)


class DropboxVFS(BaseVFS):
    accessor: DropboxAccessor
    name: str = VFSName.DROPBOX
    caches_reads: bool = True
    index_ttl: float = 86_400
    # list_folder carries an exact byte `size` for every file (0 included).
    # Paper docs 409 on raw download, a loud error, never a silent empty
    # read.
    sizes_always_known: bool = True
    # stat and every read stamp content_hash: a listing row and
    # get_metadata carry it, and a download, ranged or not, names it in
    # Dropbox-API-Result at no extra request.
    read_revalidatable: bool = True
    prompt: str = PROMPT

    reads_ranges: bool = True

    def __init__(self, config: DropboxConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = DropboxTokenManager(config)
        self.accessor = DropboxAccessor(config, self._token_manager)

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

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await truncate_by_rewrite(
            self.read, self.write, path, length, no_create
        )

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

    async def files_containing(
        self,
        text: str,
        under: list[PathSpec],
        *,
        whole_word: bool,
        ignore_case: bool,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[PathSpec] | None:
        if not whole_word or not self.accessor.config.content_search:
            return None
        return await _files_containing(self.accessor, text, under)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
