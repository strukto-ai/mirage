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

from pydantic import BaseModel

from mirage.utils.clock import SystemClock


class CacheEntry(BaseModel):
    size: int
    cached_at: int
    fingerprint: str | None = None
    ttl: int | None = None

    @property
    def expired(self) -> bool:
        """System-time expiry retained for the public v0.0.6 API.

        Stores use ``is_expired`` with their own clock instead.
        """
        return self.is_expired(int(SystemClock().now()))

    def is_expired(self, now: int) -> bool:
        """Whether this entry's TTL has run out at ``now``.

        The reading is a parameter rather than something the entry
        takes for itself: an entry is immutable data that a snapshot
        stores and restores verbatim, so it has no clock of its own to
        hold. The store that owns the entry holds the clock and says
        what the time is.

        Args:
            now (int): whole seconds since the unix epoch, from the
                owning store's clock.
        """
        if self.ttl is None:
            return False
        return (now - self.cached_at) >= self.ttl
