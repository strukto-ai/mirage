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

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres.read import first_lines as _first_lines
from mirage.core.postgres.read import follow as _follow
from mirage.core.postgres.read import last_lines as _last_lines
from mirage.core.postgres.read import line_count as _line_count
from mirage.core.postgres.read import read_stream as _read_stream
from mirage.core.postgres.readdir import readdir as _readdir
from mirage.core.postgres.search import (
    lines_containing as _lines_containing,
)
from mirage.core.postgres.stat import stat as _stat
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.postgres.config import PostgresConfig

VFS_MD = """\
{prefix}
  database.json                  cross-schema graph + sizes
  <schema>/                      Postgres schema (namespace)
    tables/<table>/
      schema.json                column types, PK/FK, indexes
      semantic.json              descriptions, roles, sample values
      rows.jsonl                 data (size-guarded)
    views/<view>/
      schema.json
      semantic.json
      rows.jsonl
  Read semantic.json to learn what a table means: it splits columns into
  dimensions (group by), time_dimensions and facts (aggregate), and
  carries COMMENTs, enum domains and example values.
  Read database.json first to plan joins. Reading rows.jsonl is refused
  for tables above the configured row/byte threshold; use head, tail or
  wc, which ask SQL for only what they need, or grep, which fetches only
  the matching rows when SQL can find every match."""


class PostgresVFS(BaseVFS):
    accessor: PostgresAccessor
    name: str = VFSName.POSTGRES
    caches_reads: bool = False
    # A live store: every readdir must hit the backend, so the index is
    # not reused across commands. Mirrors the TypeScript VFS.
    index_ttl: float = 0
    vfs_md: str = VFS_MD

    def __init__(self, config: PostgresConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = PostgresAccessor(self.config)

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read(
        self, path: PathSpec, parent: FileStat | None = None
    ) -> ByteSource:
        return _read_stream(self.accessor, path, parent)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def lines_containing(
        self, path: PathSpec, text: str, *, ignore_case: bool
    ) -> ByteSource | None:
        return await _lines_containing(self.accessor, path, text, ignore_case)

    async def first_lines(self, path: PathSpec, n: int) -> bytes | None:
        return await _first_lines(self.accessor, path, n)

    async def last_lines(self, path: PathSpec, n: int) -> bytes | None:
        return await _last_lines(self.accessor, path, n)

    async def line_count(self, path: PathSpec) -> int | None:
        return await _line_count(self.accessor, path)

    async def follow(
        self, path: PathSpec, n: int, interval: float
    ) -> AsyncIterator[bytes] | None:
        return await _follow(self.accessor, path, n, interval)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
