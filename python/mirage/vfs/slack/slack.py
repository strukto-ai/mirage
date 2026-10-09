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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.slack.constants import DU_MAX_ENTRIES
from mirage.core.slack.read import read as _read
from mirage.core.slack.read import read_range as _read_range
from mirage.core.slack.read import read_stream as _read_stream
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.stat import stat as _stat
from mirage.core.time_range import TimeRange
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.slack.config import SlackConfig
from mirage.vfs.slack.prompt import PROMPT, WRITE_PROMPT


class SlackVFS(BaseVFS):
    accessor: SlackAccessor
    name: str = VFSName.SLACK
    caches_reads: bool = True
    # Every listed file carries an exact size: chat.jsonl and users/*.json
    # are rendered at readdir from payloads the listing already fetched
    # (users.list is payload-identical to users.info, verified live), and
    # file blobs carry Slack's upload byte count.
    sizes_always_known: bool = True
    max_du_entries: int | None = DU_MAX_ENTRIES
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    reads_ranges: bool = True

    def __init__(self, config: SlackConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SlackAccessor(
            self.config,
            TimeRange.from_strings(config.start_time, config.end_time),
        )
        self.prompt = PROMPT + self.accessor.time_range.prompt()

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
        return await _read_range(self.accessor, path, index, offset, size)

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, index)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
