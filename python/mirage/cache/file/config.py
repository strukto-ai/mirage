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

from enum import Enum

from pydantic import BaseModel, ConfigDict


class CacheType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


class CacheConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: CacheType = CacheType.RAM
    limit: str | int = "512MB"
    max_drain_bytes: int | None = None


class RedisCacheConfig(CacheConfig):
    type: CacheType = CacheType.REDIS
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:cache:"
