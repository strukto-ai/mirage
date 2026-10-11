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

import asyncio

from mirage.accessor.base import SessionAccessor
from mirage.core.slack.config import SlackConfig
from mirage.core.time_range import TimeRange


class SlackAccessor(SessionAccessor):
    def __init__(
        self, config: SlackConfig, time_range: TimeRange = TimeRange()
    ) -> None:
        super().__init__()
        self.config = config
        self.time_range = time_range
        # The words of the workspace's names and the channels search
        # covers while a search fetches them, so the patterns of one grep
        # share one users.list and one channel listing.
        self.search_facts: (
            asyncio.Future[tuple[frozenset[str], frozenset[str] | None] | None]
            | None
        ) = None
