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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_buckets.create import create as _create
from mirage.core.hf_buckets.du import entries as _du_entries
from mirage.core.hf_buckets.du import size as _du_size
from mirage.core.hf_buckets.exists import exists as _exists
from mirage.core.hf_buckets.find import find as _find
from mirage.core.hf_buckets.mkdir import mkdir as _mkdir
from mirage.core.hf_buckets.read import read as _read
from mirage.core.hf_buckets.readdir import readdir as _readdir
from mirage.core.hf_buckets.rm import rm_r as _rm_r
from mirage.core.hf_buckets.stat import stat as _stat
from mirage.core.hf_buckets.stream import read_stream as _read_stream
from mirage.core.hf_buckets.unlink import unlink as _unlink
from mirage.core.hf_buckets.watch import build_delta_hook
from mirage.core.hf_buckets.write import write as _write
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.hf_buckets.config import HfBucketsConfig
from mirage.vfs.hf_buckets.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook


class HfBucketsVFS(BaseVFS):
    accessor: HfBucketsAccessor
    name: str = VFSName.HF_BUCKETS
    caches_reads: bool = True
    # The Hub tree API reports each file's exact byte size (the LFS
    # object size for LFS files); readdir backfills any lister-omitted
    # size with one stat.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True
    # stat stamps the paths-info xet hash and a read stamps its download's
    # strong ETag, which is that same hash, so a `fresh` probe compares
    # like with like.
    read_revalidatable: bool = True

    reads_ranges: bool = True

    def __init__(self, config: HfBucketsConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = HfBucketsAccessor(self.config)

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

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
