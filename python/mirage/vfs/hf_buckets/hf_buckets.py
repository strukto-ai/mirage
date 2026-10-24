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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.core.hf_buckets.create import create as _create
from mirage.core.hf_buckets.exists import exists as _exists
from mirage.core.hf_buckets.mkdir import mkdir as _mkdir
from mirage.core.hf_buckets.read import read as _read
from mirage.core.hf_buckets.readdir import readdir as _readdir
from mirage.core.hf_buckets.readdir import tree as _tree
from mirage.core.hf_buckets.rm import rm_r as _rm_r
from mirage.core.hf_buckets.stat import stat as _stat
from mirage.core.hf_buckets.stream import read_stream as _read_stream
from mirage.core.hf_buckets.unlink import unlink as _unlink
from mirage.core.hf_buckets.write import write as _write
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.hf_buckets.config import HfBucketsConfig


class HfBucketsVFS(BaseVFS):
    accessor: HfBucketsAccessor
    name: str = VFSName.HF_BUCKETS
    caches_reads: bool = True
    # The Hub tree API reports each file's exact byte size (the LFS
    # object size for LFS files); readdir backfills any lister-omitted
    # size with one stat.
    sizes_always_known: bool = True
    supports_snapshot: bool = True
    # stat stamps the paths-info xet hash and a read stamps its download's
    # strong ETag, which is that same hash, so a `fresh` probe compares
    # like with like.
    read_revalidatable: bool = True

    reads_ranges: bool = True

    def __init__(self, config: HfBucketsConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = HfBucketsAccessor(self.config)

    async def readdir(
        self, path: PathSpec, limit: int | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, limit)

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path)
        return await _read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def read_tree(
        self, path: PathSpec, limit: int | None = None
    ) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path, limit)

    async def write(self, path: PathSpec, data: ByteSource) -> FileStat | None:
        return await _write(self.accessor, path, data)

    async def create(self, path: PathSpec) -> FileStat | None:
        return await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    def storage_location(self) -> str:
        # The endpoint, the bucket and the key prefix pin the objects two
        # mounts would share.
        cfg = self.config
        prefix = (cfg.key_prefix or "").strip("/")
        base = f"{self.name}:{cfg.endpoint.rstrip('/')}:{cfg.bucket}"
        return f"{base}/{prefix}" if prefix else base

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
