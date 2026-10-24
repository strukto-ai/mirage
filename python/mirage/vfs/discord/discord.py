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

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.read import follow as _follow
from mirage.core.discord.read import read_many as _read_many
from mirage.core.discord.read import read_range as _read_range
from mirage.core.discord.read import read_stream as _read_stream
from mirage.core.discord.readdir import readdir as _readdir
from mirage.core.discord.stat import stat as _stat
from mirage.core.time_range import TimeRange
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.discord.config import DiscordConfig

VFS_MD = """\
{prefix}
  <guild-name>__<guild-id>/
    channels/
      <channel-name>__<channel-id>/
        <yyyy-mm-dd>/
          chat.jsonl              # messages for that date
          files/                  # attachments shared that day (may be empty)
            <name>__<att-id>.<ext>  # cat to download bytes from Discord CDN
    members/
      <username>__<user-id>.json  # member profile
  Naming: guild, channel, member, attachment names are `<display-name>__<id>`.
  The display name keeps the original spelling from Discord (spaces,
  apostrophes, emoji); only `/` is replaced with `∕` (U+2215) so paths
  don't break. Quote names containing spaces in shell commands. Always
  ls the parent dir first to discover exact entry names (they include
  IDs).
  Without time bounds, bare channel listings show the latest 30 days
  ending at the newest message. Date globs can discover earlier days.
  With start_time/end_time, listings cover that scope; messages and their
  attachments outside it are absent, including through direct paths.
  Users and channel metadata remain available as context.
  grep and rg read the files they reach, so grep needs -r to search a
  directory; under a channel that reads every listed day, attachments
  included (downloaded from the CDN; binary ones such as JPG or PDF
  produce noise).
  Messages are JSONL; use jq to extract fields like .content, .author.username,
  .attachments."""


class DiscordVFS(BaseVFS):
    accessor: DiscordAccessor
    name: str = VFSName.DISCORD
    caches_reads: bool = True
    # Every listed file carries an exact size: chat.jsonl and members/*.json
    # are rendered at readdir from payloads the listing already fetched, and
    # attachments carry Discord's CDN byte count.
    sizes_always_known: bool = True
    vfs_md: str = VFS_MD

    reads_ranges: bool = True

    def __init__(self, config: DiscordConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = DiscordAccessor(
            self.config,
            TimeRange.from_strings(config.start_time, config.end_time),
        )
        self.vfs_md = VFS_MD + self.accessor.time_range.vfs_md()

    async def readdir(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        limit: int | None = None,
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, entry, limit=limit)

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

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
