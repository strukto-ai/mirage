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

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.config import AirtableConfig
from mirage.core.airtable.events import build_delta_hook
from mirage.core.airtable.read import first_lines as _first_lines
from mirage.core.airtable.read import read as _read
from mirage.core.airtable.read import read_stream as _read_stream
from mirage.core.airtable.readdir import readdir as _readdir
from mirage.core.airtable.search import (
    lines_containing as _lines_containing,
)
from mirage.core.airtable.stat import stat as _stat
from mirage.events.base import DeltaHook
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.airtable.prompt import PROMPT, WRITE_PROMPT
from mirage.vfs.base import BaseVFS


class AirtableVFS(BaseVFS):
    """Airtable bases as directories, tables as records.jsonl files.

    Records are live data another client may edit at any moment, so reads
    are never served from the file cache; the schema listings still ride
    the index for its TTL.

    Args:
        config (AirtableConfig): the account and its bounds.
    """

    accessor: AirtableAccessor
    name: str = VFSName.AIRTABLE
    caches_reads: bool = False
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    def __init__(self, config: AirtableConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = AirtableAccessor(self.config)

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> bytes:
        data = await _read(self.accessor, path, entry, parent)
        return slice_window(data, offset, size)

    def read_stream(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, entry, parent)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def lines_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        ignore_case: bool,
        entry: FileStat | None = None,
    ) -> ByteSource | None:
        return await _lines_containing(self.accessor, path, text, entry)

    async def first_lines(
        self,
        path: PathSpec,
        n: int,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> bytes | None:
        return await _first_lines(self.accessor, path, n, entry, parent)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
