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

from dataclasses import dataclass
from enum import Enum

from pydantic import BaseModel, ConfigDict

from mirage.cache.index.constants import DEFAULT_KEY_PREFIX
from mirage.types import FileStat


class IndexType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


class LookupStatus(str, Enum):
    EXPIRED = "expired"
    NOT_FOUND = "not_found"


@dataclass(frozen=True, slots=True)
class IndexSnapshot:
    """Entry rows and directory children from one refill.

    ``version`` is the backend's version the rows were read at, or None.
    """

    entries: dict[str, FileStat]
    children: dict[str, list[str]]
    version: str | None = None


@dataclass(frozen=True, slots=True)
class Evicted:
    """A child a complete re-list no longer names.

    ``folder`` says whether it held a listing or was typed a folder, so
    cleanup knows to take everything cached beneath it.
    """

    path: str
    folder: bool


class LookupResult(BaseModel):
    entry: FileStat | None = None
    status: LookupStatus | None = None


class ListResult(BaseModel):
    entries: list[str] | None = None
    partial_entries: list[str] | None = None
    status: LookupStatus | None = None
    version: str | None = None
    window: bool = False


class IndexDirectory(BaseModel):
    entries: list[str]
    folders: list[int]
    expires_at: float
    generation: str
    partial: bool = False
    version: str | None = None
    window: bool = False


class IndexConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: IndexType = IndexType.RAM
    ttl: float = 600


class RedisIndexConfig(IndexConfig):
    type: IndexType = IndexType.REDIS
    url: str = "redis://localhost:6379/0"
    key_prefix: str = DEFAULT_KEY_PREFIX
