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
from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.databricks_volume.copy import copy as _copy
from mirage.core.databricks_volume.create import create as _create
from mirage.core.databricks_volume.exists import exists as _exists
from mirage.core.databricks_volume.mkdir import mkdir as _mkdir
from mirage.core.databricks_volume.read import read as _read
from mirage.core.databricks_volume.readdir import readdir as _readdir
from mirage.core.databricks_volume.rename import rename as _rename
from mirage.core.databricks_volume.rm import rm_recursive as _rm_r
from mirage.core.databricks_volume.rmdir import rmdir as _rmdir
from mirage.core.databricks_volume.stat import stat as _stat
from mirage.core.databricks_volume.stream import read_stream as _read_stream
from mirage.core.databricks_volume.unlink import unlink as _unlink
from mirage.core.databricks_volume.write import write as _write
from mirage.core.generic.rewrite import append_by_rewrite
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.databricks_volume.config import DatabricksVolumeConfig
from mirage.vfs.databricks_volume.prompt import PROMPT


class DatabricksVolumeVFS(BaseVFS):
    accessor: DatabricksVolumeAccessor
    name: str = VFSName.DATABRICKS_VOLUME
    caches_reads: bool = True
    # The Files API lists DirectoryEntry.file_size and stat HEADs report
    # Content-Length, both the exact byte count the download returns;
    # readdir backfills any lister-omitted size with one HEAD.
    sizes_always_known: bool = True
    prompt: str = PROMPT

    reads_ranges: bool = True

    def __init__(
        self,
        config: DatabricksVolumeConfig,
        client: Any | None = None,
    ) -> None:
        super().__init__()
        self.config = config
        self.accessor = DatabricksVolumeAccessor(self.config, client)

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

    async def write(self, path: PathSpec, data: bytes) -> None:
        await _write(self.accessor, path, data)

    async def append(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await append_by_rewrite(
            functools.partial(self.read, index=index),
            self.write,
            functools.partial(self.stat, index=index),
            path,
            data,
        )

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

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config, needs_override=True)
