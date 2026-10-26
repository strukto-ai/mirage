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

from collections.abc import Hashable

from mirage.accessor.base import SessionAccessor
from mirage.core.airtable.config import AirtableConfig
from mirage.core.api.rate_limit import RateLimiter
from mirage.utils.clock import Clock


class AirtableAccessor(SessionAccessor):
    """The connection pool and the per-base pacing every call rides.

    Args:
        config (AirtableConfig): the account and its bounds.
    """

    def __init__(self, config: AirtableConfig) -> None:
        super().__init__(config.timeout)
        self.config = config
        self.limiter = RateLimiter(config.requests_per_second)

    def bind_clock(self, clock: Clock, owner: Hashable) -> None:
        """Pace each base's calls on the workspace's clock.

        Args:
            clock (Clock): the workspace's clock.
            owner (Hashable): who holds it, released by the same key.

        Raises:
            ValueError: a workspace on another clock mounts it.
        """
        self.limiter.bind_clock(clock, owner)

    def release_clock(self, owner: Hashable) -> None:
        """Let ``owner`` go.

        Args:
            owner (Hashable): the key it was bound with.
        """
        self.limiter.release_clock(owner)
