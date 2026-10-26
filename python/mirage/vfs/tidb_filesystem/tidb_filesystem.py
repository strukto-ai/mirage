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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.tidb_filesystem.append import append as _append
from mirage.core.tidb_filesystem.create import create as _create
from mirage.core.tidb_filesystem.exists import exists as _exists
from mirage.core.tidb_filesystem.mkdir import mkdir as _mkdir
from mirage.core.tidb_filesystem.read import read as _read
from mirage.core.tidb_filesystem.readdir import readdir as _readdir
from mirage.core.tidb_filesystem.rename import rename as _rename
from mirage.core.tidb_filesystem.rm import rm_recursive as _rm_r
from mirage.core.tidb_filesystem.rmdir import rmdir as _rmdir
from mirage.core.tidb_filesystem.stat import stat as _stat
from mirage.core.tidb_filesystem.stream import read_stream as _read_stream
from mirage.core.tidb_filesystem.unlink import unlink as _unlink
from mirage.core.tidb_filesystem.write import write as _write
from mirage.io.types import ByteSource
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.tidb_filesystem.config import TiDBFilesystemConfig


class TiDBFilesystemVFS(BaseVFS):
    accessor: TiDBFilesystemAccessor
    name: str = VFSName.TIDB_FILESYSTEM
    caches_reads: bool = True
    # A listing row and a HEAD both carry the byte count a download
    # returns, so no file's size waits on its content.
    sizes_always_known: bool = True

    reads_ranges: bool = True

    def __init__(self, config: TiDBFilesystemConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = TiDBFilesystemAccessor(self.config)

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await _readdir(self.accessor, path)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path)
        return await _read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def write(self, path: PathSpec, data: ByteSource) -> None:
        await _write(self.accessor, path, data)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        await _append(self.accessor, path, data)

    async def create(self, path: PathSpec) -> None:
        await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(self, path: PathSpec) -> None:
        await _rmdir(self.accessor, path)

    async def rm_r(self, path: PathSpec) -> None:
        await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await _rename(self.accessor, src, dst)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config, needs_override=True)
