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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.box.capacity import capacity as _capacity
from mirage.core.box.checksum import checksum as _checksum
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.copy import copy as _copy
from mirage.core.box.create import create as _create
from mirage.core.box.events import build_delta_hook
from mirage.core.box.exists import exists as _exists
from mirage.core.box.mkdir import mkdir as _mkdir
from mirage.core.box.read import read as _read
from mirage.core.box.read import read_stream as _stream
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.rename import rename as _rename
from mirage.core.box.rmdir import rm_r as _rm_r
from mirage.core.box.rmdir import rmdir as _rmdir
from mirage.core.box.search import files_containing as _files_containing
from mirage.core.box.stat import stat as _stat
from mirage.core.box.truncate import truncate as _truncate
from mirage.core.box.unlink import unlink as _unlink
from mirage.core.box.write import write as _write
from mirage.core.box.write import write_stream as _write_stream
from mirage.events.base import DeltaHook
from mirage.io.types import ByteSource
from mirage.types import CapacityResult, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.box.config import BoxConfig
from mirage.vfs.box.prompt import PROMPT


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
        self.full_scan_limit = config.full_scan_limit
        self.accessor = BoxAccessor(self.config, BoxTokenManager(config))

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat]:
        return await _readdir(self.accessor, path, entry)

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

    async def stat(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        index: IndexCacheStore = NULL_INDEX,
    ) -> FileStat:
        return await _stat(self.accessor, path, entry, index)

    async def checksum(
        self, path: PathSpec, algorithm: str, entry: FileStat | None = None
    ) -> str | None:
        return await _checksum(self.accessor, path, algorithm, entry)

    async def exists(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> bool:
        return await _exists(self.accessor, path, entry)

    async def write(
        self,
        path: PathSpec,
        data: ByteSource,
        *,
        atomic: bool = False,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat | None:
        if isinstance(data, bytes):
            return await _write(self.accessor, path, data, entry, parent)
        return await _write_stream(self.accessor, path, data, entry, parent)

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
        dst_parent: FileStat | None = None,
        dst_entry: FileStat | None = None,
    ) -> FileStat | None:
        return await _rename(
            self.accessor, src, dst, entry, dst_parent, dst_entry
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
        if not whole_word or self.full_scan_limit < 0:
            return None
        return await _files_containing(self.accessor, text, path, entry)

    async def capacity(self) -> CapacityResult:
        return await _capacity(self.accessor)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
