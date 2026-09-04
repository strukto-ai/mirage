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


class CacheEntry(BaseModel):
    size: int
    cached_at: int
    fingerprint: str | None = None
    ttl: int | None = None

    def is_expired(self, now: int) -> bool:
        """Check expiry using the RAMFileCacheStore's clock reading.

        Args:
            now (int): whole seconds since the unix epoch.
        """
        if self.ttl is None:
            return False
        return (now - self.cached_at) >= self.ttl
