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

from collections.abc import Iterable
from typing import Any

from mirage.accessor.base import SessionAccessor
from mirage.accessor.responses import ResponseCache
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.core.discord.config import DiscordConfig
from mirage.core.time_range import TimeRange


class DiscordAccessor(SessionAccessor):
    def __init__(
        self, config: DiscordConfig, time_range: TimeRange = TimeRange()
    ) -> None:
        super().__init__(config.timeout)
        self.config = config
        self.time_range = time_range
        self.listed_day = ResponseCache[
            tuple[int, str, str], list[dict[str, Any]]
        ](ttl=LISTING_TRUST_WINDOW)

    def caches(self) -> Iterable[ResponseCache[Any, Any]]:
        return (self.listed_day,)
