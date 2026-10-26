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

import functools
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.capacity import capacity as _capacity
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.core.dropbox.copy import copy as _copy
from mirage.core.dropbox.copy import dir_copy as _dir_copy
from mirage.core.dropbox.create import create as _create
from mirage.core.dropbox.events import build_delta_hook
from mirage.core.dropbox.exists import exists as _exists
from mirage.core.dropbox.mkdir import mkdir as _mkdir
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.read import read_by_path as _read_by_path
from mirage.core.dropbox.read import read_stream as _stream
from mirage.core.dropbox.readdir import readdir as _readdir
from mirage.core.dropbox.rename import rename as _rename
from mirage.core.dropbox.rm import rm_r as _rm_r
from mirage.core.dropbox.rmdir import rmdir as _rmdir
from mirage.core.dropbox.search import files_containing as _files_containing
from mirage.core.dropbox.stat import stat as _stat
from mirage.core.dropbox.stat import tree as _tree
from mirage.core.dropbox.unlink import unlink as _unlink
from mirage.core.dropbox.write import write as _write
from mirage.core.generic.rewrite import truncate_by_rewrite
from mirage.events.base import DeltaHook
from mirage.io.types import ByteSource
from mirage.types import (
    CapacityResult,
    DirListing,
    FileStat,
    PathSpec,
    VFSName,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.dropbox.config import DropboxConfig


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
    whole_word_search: bool = True

    reads_ranges: bool = True

    def __init__(self, config: DropboxConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = DropboxAccessor(config, DropboxTokenManager(config))

    async def readdir(
        self, path: PathSpec, limit: int | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, limit)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _stream(self.accessor, path, entry)
        return await _read(self.accessor, path, offset, size, entry)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def write(
        self, path: PathSpec, data: ByteSource, *, atomic: bool = False
    ) -> FileStat | None:
        return await _write(self.accessor, path, data)

    async def create(self, path: PathSpec) -> FileStat | None:
        return await _create(self.accessor, path)

    async def truncate(
        self,
        path: PathSpec,
        length: int,
        no_create: bool = False,
        entry: FileStat | None = None,
    ) -> None:
        await truncate_by_rewrite(
            (
                functools.partial(_read_by_path, self.accessor)
                if entry is None
                else functools.partial(_read, self.accessor, entry=entry)
            ),
            self.write,
            path,
            length,
            no_create,
        )

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(self, path: PathSpec) -> None:
        await _rmdir(self.accessor, path)

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await _rename(self.accessor, src, dst)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _dir_copy(self.accessor, src, dst)

    def supports(self, name: str) -> bool:
        """Whether this VFS answers ``name``; with no walk limit it reads
        every file rather than ask the service's search.

        Args:
            name (str): the function name.
        """
        if name == "files_containing" and self.walk_limit < 0:
            return False
        return super().supports(name)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if not whole_word or self.walk_limit < 0:
            return None
        return await _files_containing(self.accessor, text, [path])

    async def capacity(self) -> CapacityResult:
        return await _capacity(self.accessor)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
