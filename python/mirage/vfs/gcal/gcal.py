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

from datetime import date
from typing import Any

from mirage.accessor.gcal import GCalAccessor
from mirage.core.gcal.day import bucket_name, bucket_start
from mirage.core.gcal.read import read as _read
from mirage.core.gcal.read import read_many as _read_many
from mirage.core.gcal.readdir import readdir as _readdir
from mirage.core.gcal.search import files_containing as _files_containing
from mirage.core.gcal.stat import stat as _stat
from mirage.core.gcal.unlink import unlink as _unlink
from mirage.core.gcal.watch import build_delta_hook
from mirage.core.google.client import TokenManager
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.gcal.config import GCalConfig
from mirage.vfs.gcal.prompt import (
    BUCKET_PROMPT,
    DAY_PROMPT,
    PROMPT,
    WRITE_PROMPT,
)
from mirage.watch.base import DeltaHook

EXAMPLE_DAY = date(2026, 8, 11)


def tree_prompt(size: int) -> str:
    """The prompt for a mount's tree, its examples named on that grid.

    Args:
        size (int): the mount's bucket length in days.
    """
    layout = DAY_PROMPT if size == 1 else BUCKET_PROMPT
    bucket = bucket_name(bucket_start(EXAMPLE_DAY, size), size)
    day = "" if size == 1 else f"{EXAMPLE_DAY.isoformat()}_"
    return (
        PROMPT.replace("{layout}", layout)
        .replace("{days}", str(size))
        .replace("{bucket}", bucket)
        .replace("{day}", day)
    )


class GCalVFS(BaseVFS):
    accessor: GCalAccessor
    name: str = VFSName.GCAL
    caches_reads: bool = True
    # Shorter than the other Google mounts: a calendar is edited by other
    # people and a day-long index would keep serving a schedule that has
    # already moved.
    index_ttl: float = 300
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT
    searchable = ("*/*/*.gcal.json",)

    def __init__(self, config: GCalConfig) -> None:
        super().__init__()
        self.config = config
        self._token_manager = TokenManager(config)
        self.accessor = GCalAccessor(self.config, self._token_manager)
        self.prompt = (
            tree_prompt(config.bucket_days) + self.accessor.time_range.prompt()
        )

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> bytes:
        data = await _read(self.accessor, path)
        return slice_window(data, offset, size)

    async def read_many(
        self, paths: list[PathSpec], limit: int
    ) -> dict[str, bytes]:
        return await _read_many(self.accessor, paths, limit)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if not whole_word or not self.config.content_search:
            return None
        return await _files_containing(self.accessor, text, [path])

    async def unlink(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        await _unlink(self.accessor, path, entry)

    async def close(self) -> None:
        """Drain the token manager's connection pool with the VFS."""
        await self._token_manager.close()
        await super().close()

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
