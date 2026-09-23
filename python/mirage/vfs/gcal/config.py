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

from mirage.core.google.config import GoogleConfig


class GCalConfig(GoogleConfig):
    # One zone for the whole mount, not one per calendar: the Calendar UI
    # draws its whole grid in the primary zone, and per-calendar bucketing
    # would make the same day directory name mean different 24-hour windows
    # on different calendars. Defaults to the primary calendar's zone.
    time_zone: str | None = None
    # Keep only calendars at or above this accessRole, e.g. "writer" for
    # ones the agent can actually schedule into.
    min_access_role: str | None = None
    # Pin the day the rolling window centres on; test and snapshot use.
    today: str | None = None
