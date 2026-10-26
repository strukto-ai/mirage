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

from mirage.accessor.notion import NotionAccessor
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.read import first_lines as _first_lines
from mirage.core.notion.read import read_stream as _read_stream
from mirage.core.notion.readdir import readdir as _readdir
from mirage.core.notion.stat import stat as _stat
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS

VFS_MD = """\
{prefix}
  pages/
    <page-title>__<page-id>/
      page.json
      <child-page-title>__<child-id>/
        page.json
  databases/
    <database-title>__<database-id>/
      database.json
      <data-source-title>__<data-source-id>/
        data_source.json
        rows.jsonl
  Hierarchical page tree plus shared databases. cat page.json shows
  metadata, the page body rendered as markdown, and raw blocks (nested
  blocks under "children"). A database is a container plus one or more
  data sources: database.json holds the container's identity and its
  data_sources stubs, data_source.json holds the typed property schema,
  and rows.jsonl holds the rows, one JSON line each: the row page's
  page.json without the body, plus "path", that page.json's path below
  the data source dir. Row dirs are not listed; open one by its path.

  Titles are sanitized; don't construct paths: ls the parent dir, or
  take a row's "path" from rows.jsonl.
  ntn takes ids as positional operands, not flags: ntn pages get
  <page-id>, ntn datasources query <data-source-id>, ntn datasources
  resolve <database-id>."""


class NotionVFS(BaseVFS):
    accessor: NotionAccessor
    name: str = VFSName.NOTION
    caches_reads: bool = True
    vfs_md: str = VFS_MD

    def __init__(self, config: NotionConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = NotionAccessor(config)

    async def readdir(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry, parent)

    async def read(
        self, path: PathSpec, parent: FileStat | None = None
    ) -> ByteSource:
        return _read_stream(self.accessor, path, parent)

    async def first_lines(
        self, path: PathSpec, n: int, parent: FileStat | None = None
    ) -> bytes | None:
        return await _first_lines(self.accessor, path, n, parent)

    async def stat(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat:
        return await _stat(self.accessor, path, entry, parent)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
