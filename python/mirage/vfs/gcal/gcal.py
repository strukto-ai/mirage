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
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.gcal.config import GCalConfig

VFS_MD = """Google Calendar is mounted as one directory per calendar, one
directory per date bucket, and one JSON file per event.

    /<mount>/primary/calendar.json
    /<mount>/primary/{bucket}/<eventId>__{day}0900-1030_Team_Standup.gcal.json
    /<mount>/Engineering__team@group.calendar.google.com/{bucket}/...

Reading the tree:

- `ls <mount>/` lists the calendars. The primary one is always spelled
  `primary`; every other directory ends in `__<calendarId>`.
- `ls <mount>/primary/` lists buckets with events from all available history
  through today +90 days unless end_time is configured. start_time/end_time
  restrict this mount, including direct paths, date globs and event reads.
  A date glob such as `ls <mount>/primary/2027-03-*` selects its own
  listing range within that scope, beyond the default future horizon.
{layout}
- `cat` an event for the unmodified Calendar API payload, including
  attendees, description, location and the original start/end with offsets.
- `calendar.json` carries the calendar's accessRole and, in
  `bucketTimeZone`, the zone the buckets are cut in. That zone is
  mount-wide, so every calendar's `{bucket}/` covers the same hours.
- On a calendar shared as free/busy only, Google returns no titles at all,
  so events render as `busy`.

Acting on it:

- On a `write` path, `rm` an event file to delete that event for every
  attendee.
- Everything else goes through the `gws calendar` CLI, which takes the ids
  the tree renders.
- A written event must carry an explicit UTC offset or timeZone; an
  ambiguous local time is not interpreted for you.
"""

DAY_VFS_MD = """\
- A bucket is one local day, named by its date. A well-formed date inside
  the configured scope is a directory even when it holds no events. Dates
  outside the scope are absent.
- A file name is `<eventId>__<HHMM-HHMM>_<Title>.gcal.json`. The times are
  clamped to that day, so an event running through it reads `0000-2400`.
  A multi-day event appears under every day it covers."""

BUCKET_VFS_MD = """\
- A bucket is {days} local days, named by its first and last day on a
  fixed grid where 7-day buckets run Monday to Sunday. A bucket on the grid
  inside the configured scope is a directory even when it holds no events;
  a bare date, a span off the grid and a bucket outside the scope are
  absent. A glob matches the name, so `2027-03-*` finds the buckets that
  open in March.
- A file name is `<eventId>__<YYYY-MM-DD>_<HHMM-HHMM>_<Title>.gcal.json`,
  dated with its day. The times are clamped to that day, so an event
  running through it reads `0000-2400`. A multi-day event appears once for
  each day of the bucket it covers."""

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
    searchable = ("*/*/*.gcal.json",)

    def __init__(self, config: GCalConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = GCalAccessor(self.config, TokenManager(config))
        self.vfs_md = (
            tree_vfs_md(config.bucket_days) + self.accessor.time_range.vfs_md()
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

    def supports(self, name: str) -> bool:
        """Whether this VFS answers ``name``; with no walk limit it reads
        every file rather than ask the service's search.

        Args:
            name (str): the function name.
        """
        if name == "files_containing" and self.walk_limit < 0:
            return False
        return super().supports(name)

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
