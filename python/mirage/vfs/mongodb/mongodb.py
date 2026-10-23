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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.read import read as _read
from mirage.core.mongodb.read import stream_any as _read_stream
from mirage.core.mongodb.readdir import readdir as _readdir
from mirage.core.mongodb.search import (
    lines_containing as _lines_containing,
)
from mirage.core.mongodb.stat import stat as _stat
from mirage.core.mongodb.stream import follow as _follow
from mirage.core.mongodb.stream import last_lines as _last_lines
from mirage.core.mongodb.stream import line_count as _line_count
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.mongodb.config import MongoDBConfig
from mirage.vfs.mongodb.prompt import PROMPT


class MongoDBVFS(BaseVFS):
    accessor: MongoDBAccessor
    name: str = VFSName.MONGODB
    caches_reads: bool = False
    # A live store: every readdir must hit the backend, so the index is
    # not reused across commands. Mirrors the TypeScript VFS.
    index_ttl: float = 0
    prompt: str = PROMPT

    def __init__(self, config: MongoDBConfig) -> None:
        super().__init__()
        self.config = config
        self.full_scan_limit = config.full_scan_limit
        self.accessor = MongoDBAccessor(self.config)

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path)
        data = await _read(self.accessor, path)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def lines_containing(
        self, path: PathSpec, text: str, *, ignore_case: bool
    ) -> ByteSource | None:
        return await _lines_containing(self.accessor, path, text)

    async def last_lines(self, path: PathSpec, n: int) -> bytes | None:
        return await _last_lines(self.accessor, path, n)

    async def line_count(self, path: PathSpec) -> int | None:
        return await _line_count(self.accessor, path)

    async def follow(
        self, path: PathSpec, n: int, interval: float
    ) -> AsyncIterator[bytes] | None:
        return await _follow(self.accessor, path, n)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
