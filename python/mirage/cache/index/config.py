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
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ResourceType(str, Enum):
    FILE = "file"
    FOLDER = "folder"


def is_folder_kind(resource_type: str) -> bool:
    """Whether a row's type names a folder: ``folder`` or ``<backend>/folder``.

    A backend may spell its kinds under its own prefix (``dropbox/folder``,
    ``box/folder``); a type outside that convention (``wandb/directory``)
    is no evidence either way. A caller holding no row checks for that
    first; the TypeScript twin takes ``undefined`` for it instead, the
    shape an optional-chained map lookup gives.

    Args:
        resource_type (str): the row's ``resource_type``.
    """
    return _is_kind(resource_type, ResourceType.FOLDER)


def is_file_kind(resource_type: str) -> bool:
    """Whether a row's type names a file: ``file`` or ``<backend>/file``.

    Args:
        resource_type (str): the row's ``resource_type``.
    """
    return _is_kind(resource_type, ResourceType.FILE)


def _is_kind(resource_type: str, kind: ResourceType) -> bool:
    return resource_type == kind.value or resource_type.endswith(
        "/" + kind.value
    )


class IndexType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


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


@dataclass(frozen=True, slots=True)
class IndexSnapshot:
    """Entry rows and directory children from one refill.

    ``version`` is the backend's version the rows were read at, or None.
    """

    entries: dict[str, IndexEntry]
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
    entry: IndexEntry | None = None
    status: LookupStatus | None = None


class ListResult(BaseModel):
    entries: list[str] | None = None
    partial_entries: list[str] | None = None
    status: LookupStatus | None = None
    version: str | None = None


class IndexDirectory(BaseModel):
    entries: list[str]
    expires_at: float
    generation: str
    partial: bool = False
    version: str | None = None


class IndexConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: IndexType = IndexType.RAM
    ttl: float = 600


class RedisIndexConfig(IndexConfig):
    type: IndexType = IndexType.REDIS
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:index:"
