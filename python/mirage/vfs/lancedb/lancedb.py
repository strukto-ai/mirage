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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.lancedb.search import files_containing as _files_containing
from mirage.core.lancedb.tree import SEARCH, read, readdir, stat
from mirage.types import DirListing, FileStat, PathSpec, SearchQuery, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.lancedb.config import LanceDBConfig

VFS_MD = """\
This mount is a LanceDB table exposed as a filesystem.

Directories are the configured group-by columns; descending narrows a filter.
Each matching row is a <id>.md card plus a <id>.<ext> blob file. Use
ls/cd/cat/tree/find/wc/grep/rg as usual."""

_REMOTE_SCHEMES = ("s3://", "gs://", "az://", "hf://", "db://")


class LanceDBVFS(BaseVFS):
    accessor: LanceDBAccessor
    name: str = VFSName.LANCEDB
    # readdir seeds exact card sizes from the widened select and stat falls
    # back to rendering the row itself, so sizes are exact either way.
    sizes_always_known: bool = True
    # A live store: every readdir must hit the backend, so the index is
    # not reused across commands. Mirrors the TypeScript VFS.
    index_ttl: float = 0
    vfs_md: str = VFS_MD

    def __init__(self, config: LanceDBConfig) -> None:
        super().__init__()
        self.config = config
        self.caches_reads = config.uri.startswith(_REMOTE_SCHEMES)
        self.accessor = LanceDBAccessor(self.config)
        # Only cards are searched: a blob file is the blob column's bytes.
        depth = len(config.group_by) + (0 if config.table else 1)
        self.searchable = ("/".join(["*"] * depth + ["*.md"]),)

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await readdir(self.accessor, path)

    async def read(self, path: PathSpec) -> bytes:
        return await read(self.accessor, path)

    async def stat(self, path: PathSpec) -> FileStat:
        return await stat(self.accessor, path)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        return await _files_containing(
            self.accessor, text, [path], whole_word, ignore_case
        )

    async def search(
        self, path: PathSpec, query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        return await SEARCH.search(self.accessor, path, query)

    async def search_many(
        self, paths: list[PathSpec], query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        return await SEARCH.search_many(self.accessor, paths, query)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
