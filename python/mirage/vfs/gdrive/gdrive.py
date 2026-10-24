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
from mirage.core.gdrive.capacity import capacity as _capacity
from mirage.core.gdrive.checksum import checksum as _checksum
from mirage.core.gdrive.copy import copy as _copy
from mirage.core.gdrive.create import create as _create
from mirage.core.gdrive.events import build_delta_hook
from mirage.core.gdrive.exists import exists as _exists
from mirage.core.gdrive.mkdir import mkdir as _mkdir
from mirage.core.gdrive.read import read as _read
from mirage.core.gdrive.read import read_stream as _read_stream
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.core.gdrive.rename import rename as _rename
from mirage.core.gdrive.rm import rm_r as _rm_r
from mirage.core.gdrive.rmdir import rmdir as _rmdir
from mirage.core.gdrive.search import files_containing as _files_containing
from mirage.core.gdrive.set_attrs import set_attrs as _set_attrs
from mirage.core.gdrive.stat import stat as _stat
from mirage.core.gdrive.tree import tree as _tree
from mirage.core.gdrive.truncate import truncate as _truncate
from mirage.core.gdrive.unlink import unlink as _unlink
from mirage.core.gdrive.write import write as _write
from mirage.core.google.client import TokenManager
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
from mirage.vfs.gdrive.config import GoogleDriveConfig
from mirage.vfs.gdrive.prompt import PROMPT


class GoogleDriveVFS(BaseVFS):
    accessor: GDriveAccessor
    name: str = VFSName.GDRIVE
    caches_reads: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    whole_word_search: bool = True
    supports_snapshot: bool = True
    read_revalidatable: bool = True

    reads_ranges: bool = True

    def __init__(self, config: GoogleDriveConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = GDriveAccessor(self.config, TokenManager(config))

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path, entry)
        return await _read(self.accessor, path, offset, size, entry)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def checksum(
        self, path: PathSpec, algorithm: str, entry: FileStat | None = None
    ) -> str | None:
        return await _checksum(self.accessor, path, algorithm, entry)

    async def exists(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> bool:
        return await _exists(self.accessor, path, entry)

    async def read_tree(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path, entry)

    async def write(
        self,
        path: PathSpec,
        data: ByteSource,
        *,
        atomic: bool = False,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat | None:
        return await _write(self.accessor, path, data, entry, parent)

    async def create(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat | None:
        return await _create(self.accessor, path, entry, parent)

    async def unlink(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        await _unlink(self.accessor, path, entry)

    async def mkdir(
        self,
        path: PathSpec,
        parents: bool = False,
        parent: FileStat | None = None,
    ) -> FileStat | None:
        return await _mkdir(self.accessor, path, parents, parent)

    async def rmdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        await _rmdir(self.accessor, path, entry)

    async def rm_r(self, path: PathSpec, entry: FileStat | None = None) -> Any:
        return await _rm_r(self.accessor, path, entry)

    async def rename(
        self,
        src: PathSpec,
        dst: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
        dst_parent: FileStat | None = None,
        dst_entry: FileStat | None = None,
    ) -> FileStat | None:
        return await _rename(
            self.accessor, src, dst, entry, parent, dst_parent, dst_entry
        )

    async def copy(
        self,
        src: PathSpec,
        dst: PathSpec,
        entry: FileStat | None = None,
        dst_parent: FileStat | None = None,
        dst_entry: FileStat | None = None,
    ) -> FileStat | None:
        return await _copy(
            self.accessor, src, dst, entry, dst_parent, dst_entry
        )

    async def dir_copy(
        self,
        src: PathSpec,
        dst: PathSpec,
        entry: FileStat | None = None,
        dst_parent: FileStat | None = None,
        dst_entry: FileStat | None = None,
    ) -> FileStat | None:
        return await _copy(
            self.accessor, src, dst, entry, dst_parent, dst_entry
        )

    async def truncate(
        self,
        path: PathSpec,
        length: int,
        no_create: bool = False,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> None:
        await _truncate(self.accessor, path, length, no_create, entry, parent)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
        entry: FileStat | None = None,
    ) -> list[PathSpec] | None:
        if not whole_word or self.walk_limit < 0:
            return None
        return await _files_containing(self.accessor, text, path, entry)

    async def setattr(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
    ) -> dict[str, int | str]:
        return await _set_attrs(
            self.accessor,
            path,
            entry,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
        )

    async def capacity(self) -> CapacityResult:
        return await _capacity(self.accessor)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
