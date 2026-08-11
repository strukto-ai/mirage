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

from datetime import date, datetime

from mirage.accessor.base import Accessor
from mirage.core.gcal.day import zone
from mirage.core.google._client import TokenManager
from mirage.resource.gcal.config import GCalConfig


class GCalAccessor(Accessor):

    def __init__(self, config: GCalConfig,
                 token_manager: TokenManager) -> None:
        self.config = config
        self.token_manager = token_manager

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
