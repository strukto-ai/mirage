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
from mirage.core.gcal.events import build_delta_hook
from mirage.core.gcal.read import read as _read
from mirage.core.gcal.read import read_many as _read_many
from mirage.core.gcal.readdir import readdir as _readdir
from mirage.core.gcal.search import files_containing as _files_containing
from mirage.core.gcal.stat import stat as _stat
from mirage.core.gcal.unlink import unlink as _unlink
from mirage.core.google.client import TokenManager
from mirage.events.base import DeltaHook
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.gcal.config import GCalConfig

VFS_MD = """\
```text
{prefix}
  primary/
    calendar.json
    {bucket}/
      <eventId>__{day}0900-1030_Team_Standup.gcal.json
  Engineering__team@group.calendar.google.com/
    {bucket}/
      ...
```

- Calendars are `primary` and `<Name>__<calendarId>`; `calendar.json`
  holds the calendar's `accessRole` and `bucketTimeZone`, the zone every
  bucket is cut in.
{layout}
- `cat` an event for the raw Calendar API JSON (attendees, description,
  location, start and end with offsets).
- A listing runs through today +90 days unless `end_time` is set; a date
  glob such as `2027-03-*` reaches past that.
- On a `write` path, `rm` an event file deletes it for every attendee.
  Other changes go through the `gws calendar` CLI, with explicit offsets
  or a `timeZone`."""

DAY_VFS_MD = """\
- A bucket is one local day. A file is
  `<eventId>__<HHMM-HHMM>_<Title>.gcal.json`, times clamped to the day; a
  multi-day event appears under each day."""

BUCKET_VFS_MD = """\
- A bucket is {days} local days on a fixed grid (7-day buckets run Monday
  to Sunday). A file is
  `<eventId>__<YYYY-MM-DD>_<HHMM-HHMM>_<Title>.gcal.json`, one per day the
  event covers, times clamped to that day."""

EXAMPLE_DAY = date(2026, 8, 11)


def tree_vfs_md(size: int) -> str:
    """The VFS.md text for a mount's tree, its examples named on that grid.

    Args:
        size (int): the mount's bucket length in days.
    """
    layout = DAY_VFS_MD if size == 1 else BUCKET_VFS_MD
    bucket = bucket_name(bucket_start(EXAMPLE_DAY, size), size)
    day = "" if size == 1 else f"{EXAMPLE_DAY.isoformat()}_"
    return (
        VFS_MD.replace("{layout}", layout)
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
    vfs_md: str = VFS_MD
    whole_word_search: bool = True
    search_needs_walk_limit: bool = True
    searchable = ("*/*/*.gcal.json",)

    def __init__(self, config: GCalConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = GCalAccessor(
            self.config, TokenManager(config), lambda: self.walk_limit >= 0
        )
        self.vfs_md = (
            tree_vfs_md(config.bucket_days) + self.accessor.time_range.vfs_md()
        )

    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path)

    async def read(self, path: PathSpec) -> bytes:
        return await _read(self.accessor, path)

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
        if not whole_word or self.walk_limit < 0:
            return None
        return await _files_containing(self.accessor, text, [path])

    async def unlink(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        await _unlink(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
