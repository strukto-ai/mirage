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

import time
from enum import Enum

from pydantic import BaseModel


class Holds(Enum):
    """What a cache entry holds."""

    BYTES = "bytes"
    BYTES_AND_VERSION = "bytes_and_version"
    VERSION = "version"


class CacheEntry(BaseModel):
    size: int
    cached_at: int
    fingerprint: str | None = None
    ttl: int | None = None
    holds: Holds = Holds.BYTES

    @property
    def has_bytes(self) -> bool:
        """Whether the entry holds the file's bytes, not only its version."""
        return self.holds is not Holds.VERSION

    @property
    def expired(self) -> bool:
        if self.ttl is None:
            return False
        return (int(time.time()) - self.cached_at) >= self.ttl
