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

from collections.abc import Callable
from datetime import date, datetime

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.gcal.day import zone
from mirage.core.google.client import TokenManager
from mirage.core.time_range import TimeRange
from mirage.vfs.gcal.config import GCalConfig


class GCalAccessor(GoogleApiAccessor):
    config: GCalConfig

    def __init__(
        self,
        config: GCalConfig,
        token_manager: TokenManager,
        capped: Callable[[], bool] = lambda: True,
    ) -> None:
        """Args:
        config (GCalConfig): the account and the listing window.
        token_manager (TokenManager): its tokens.
        capped (Callable[[], bool]): whether the mount walks under a
            ``walk_limit``, asked when a listing runs, since the mount
            settles its own once mounted; a listing then keeps each
            event's unsearched text for the search.
        """
        super().__init__(config, token_manager)
        self.capped = capped
        self.time_range = TimeRange.from_strings(
            config.start_time, config.end_time
        )

    def today(self, tz: str) -> date:
        """The day the default listing window centres on.

        Taken in the mount's bucketing zone rather than the host's: the two
        disagree for several hours a day, so a window centred on the wrong
        one shifts the whole listing by a day around either midnight.

        A method rather than a module-level call so a test can pin it and so
        a long-lived mount does not freeze its window at import time.

        Args:
            tz (str): the mount-wide bucketing zone.

        Returns:
            date: today in that zone, or the pinned day.
        """
        if self.config.today:
            return date.fromisoformat(self.config.today)
        return datetime.now(zone(tz)).date()
