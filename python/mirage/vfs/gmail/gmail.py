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

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.events import build_delta_hook
from mirage.core.gmail.read import read as _read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.search import files_containing as _files_containing
from mirage.core.gmail.stat import stat as _stat
from mirage.core.google.client import TokenManager
from mirage.events.base import DeltaHook
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.gmail.config import GmailConfig
from mirage.vfs.gmail.prompt import PROMPT, WRITE_PROMPT


class GmailVFS(BaseVFS):
    accessor: GmailAccessor
    name: str = VFSName.GMAIL
    caches_reads: bool = True
    # Every listed file carries an exact size: .gmail.json is rendered at
    # readdir from the full message the listing already fetched, and
    # attachments carry the decoded byte count.
    sizes_always_known: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT
    # The listing keeps each message's text; an attachment is read as usual.
    searchable = ("*/*/*.gmail.json",)

    def __init__(self, config: GmailConfig) -> None:
        super().__init__()
        self.config = config
        self.full_scan_limit = config.full_scan_limit
        self.accessor = GmailAccessor(self.config, TokenManager(config))

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
    ) -> bytes:
        data = await _read(self.accessor, path, entry)
        return slice_window(data, offset, size)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def stat(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat:
        return await _stat(self.accessor, path, entry, parent)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if self.full_scan_limit < 0:
            return None
        return await _files_containing(self.accessor, text, [path])

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
