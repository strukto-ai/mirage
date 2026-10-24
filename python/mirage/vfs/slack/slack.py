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
from mirage.core.slack.client import slack_search_available
from mirage.core.slack.read import follow as _follow
from mirage.core.slack.read import read_many as _read_many
from mirage.core.slack.read import read_range as _read_range
from mirage.core.slack.read import read_stream as _read_stream
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.search import files_containing as _files_containing
from mirage.core.slack.stat import stat as _stat
from mirage.core.time_range import TimeRange
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
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
    prompt: str = PROMPT
    write_prompt: str = WRITE_PROMPT

    reads_ranges: bool = True
    # Slack search names channel and DM days; users and file blobs are
    # read as usual.
    searchable = ("channels/*/*/chat.jsonl", "dms/*/*/chat.jsonl")

    def __init__(self, config: SlackConfig) -> None:
        super().__init__()
        self.config = config
        self.full_scan_limit = config.full_scan_limit
        self.accessor = SlackAccessor(
            self.config,
            TimeRange.from_strings(config.start_time, config.end_time),
        )
        self.prompt = PROMPT + self.accessor.time_range.prompt()

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
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path, entry, parent)
        return await _read_range(
            self.accessor, path, offset, size, entry, parent
        )

    async def read_many(
        self,
        paths: list[PathSpec],
        limit: int,
        entries: list[FileStat | None] | None = None,
        parents: list[FileStat | None] | None = None,
    ) -> dict[str, bytes]:
        unknown: list[FileStat | None] = [None] * len(paths)
        return await _read_many(
            self.accessor, paths, limit, entries or unknown, parents or unknown
        )

    async def follow(
        self,
        path: PathSpec,
        n: int,
        interval: float,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> AsyncIterator[bytes] | None:
        return await _follow(
            self.accessor, path, n, interval, entry=entry, parent=parent
        )

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
        if (
            not whole_word
            or self.full_scan_limit < 0
            or not slack_search_available(self.config)
        ):
            return None
        return await _files_containing(self.accessor, text, [path])

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
