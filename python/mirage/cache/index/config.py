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

from pydantic import BaseModel, Field

from mirage.types import IndexType


class ResourceType(str, Enum):
    FILE = "file"
    FOLDER = "folder"


class LookupStatus(str, Enum):
    EXPIRED = "expired"
    NOT_FOUND = "not_found"


class IndexEntry(BaseModel):
    id: str
    name: str
    resource_type: str
    remote_time: str = ""
    index_time: str = ""
    vfs_name: str = ""
    size: int | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class LookupResult(BaseModel):
    entry: IndexEntry | None = None
    status: LookupStatus | None = None


class ListResult(BaseModel):
    entries: list[str] | None = None
    status: LookupStatus | None = None


class IndexConfig(BaseModel):
    type: IndexType = IndexType.RAM
    ttl: float = 600


class RedisIndexConfig(IndexConfig):
    type: IndexType = IndexType.REDIS
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:index:"
