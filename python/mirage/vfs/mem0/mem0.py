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

from mirage.accessor.mem0 import Mem0Accessor
from mirage.core.mem0.read import read_stream as _read_stream
from mirage.core.mem0.readdir import readdir as _readdir
from mirage.core.mem0.search import search_many
from mirage.core.mem0.stat import stat as _stat
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, SearchQuery, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.mem0.config import Mem0Config

VFS_MD = """\
{prefix}
  <memory-id>.json
  search "<query>" [path ...] ranks memories by meaning: --method takes only
  semantic, --top-k N caps the hits and --threshold F keeps those scoring at
  least F, from 0 to 1."""


class Mem0VFS(BaseVFS):
    accessor: Mem0Accessor
    name: str = VFSName.MEM0
    caches_reads: bool = True
    # readdir and stat store the rendered JSON's byte length and read
    # serves those same bytes, so sizes are exact by construction.
    sizes_always_known: bool = True
    vfs_md: str = VFS_MD
    supports_snapshot: bool = False

    def __init__(self, config: Mem0Config) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = Mem0Accessor(self.config)

    async def readdir(
        self, path: PathSpec, limit: int | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, limit=limit)

    async def read(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> ByteSource:
        return _read_stream(self.accessor, path, entry)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def search(
        self, path: PathSpec, query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        return await search_many(self.accessor, [path], query)

    async def search_many(
        self, paths: list[PathSpec], query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        return await search_many(self.accessor, paths, query)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
