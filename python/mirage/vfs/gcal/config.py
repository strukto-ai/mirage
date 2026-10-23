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

from typing import Literal

from pydantic import Field

from mirage.core.google.config import GoogleConfig
from mirage.core.time_config import TimeRangeConfig
from mirage.vfs.constants import FULL_SCAN_LIMIT


class GCalConfig(GoogleConfig, TimeRangeConfig):
    # One zone for the whole mount, not one per calendar: the Calendar UI
    # draws its whole grid in the primary zone, and per-calendar bucketing
    # would make the same day directory name mean different 24-hour windows
    # on different calendars.
    time_zone: str | None = None
    """IANA time zone the mount buckets every calendar's days in. Unset
    uses the primary calendar's zone."""
    bucket_days: Literal[1, 7, 30] = 1
    """Days each date directory under a calendar holds: `1` names it by its
    day, `7` and `30` by its first and last day (`<first>--<last>`)."""
    min_access_role: str | None = None
    """List only calendars where the account has at least this access role:
    `freeBusyReader`, `reader`, `writer` or `owner`. Unset lists every
    calendar."""
    today: str | None = None
    """Day (`YYYY-MM-DD`) the default listing's 90-day future horizon is
    measured from, for tests and snapshots. Unset uses the current date in
    the mount's time zone."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit and reads every event without asking
    Calendar's search; the listing then keeps no event text."""
