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
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from mirage.utils.size import parse_limit


class CacheType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


class CacheConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: CacheType = CacheType.RAM
    limit: str | int = "512MB"
    max_drain_bytes: int | None = None

    @field_validator("limit", mode="before")
    @classmethod
    def _v_limit(cls, v: Any) -> Any:
        parse_limit(v, "limit")
        return v


class RedisCacheConfig(CacheConfig):
    type: CacheType = CacheType.REDIS
    url: str = "redis://localhost:6379/0"
    # None scopes the keys to the workspace; a prefix shares them with
    # every workspace that names it.
    key_prefix: str | None = None
