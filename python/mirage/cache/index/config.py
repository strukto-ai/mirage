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

import json
from dataclasses import dataclass
from enum import Enum

from pydantic import BaseModel, ConfigDict, field_validator

from mirage.types import ContentType, FileStat, FileType


class IndexType(str, Enum):
    RAM = "ram"
    REDIS = "redis"


class LookupStatus(str, Enum):
    EXPIRED = "expired"
    NOT_FOUND = "not_found"


def row_json(entry: FileStat) -> str:
    """A stat row's wire form, the JSON both hosts' index stores share:
    every field in declaration order, compact, as TypeScript's
    ``JSON.stringify`` writes a ``FileStat``.

    Args:
        entry (FileStat): the row.
    """
    return json.dumps(
        {name: getattr(entry, name) for name in FileStat.__dataclass_fields__},
        separators=(",", ":"),
        ensure_ascii=False,
    )


def parse_row(raw: str | bytes) -> FileStat:
    """A stat row read back from its wire form: a field it lacks takes
    its default and one this host does not know is dropped, as
    TypeScript's ``FileStatWireSchema`` parses it.

    Args:
        raw (str | bytes): the stored JSON.

    Raises:
        ValueError: the JSON is not a row: no name or type, or a type or
            content this host does not know.
    """
    data = json.loads(raw)
    if not isinstance(data, dict) or not {"name", "type"} <= data.keys():
        raise ValueError("an index row needs a name and a type")
    known = {
        name: data[name]
        for name in FileStat.__dataclass_fields__
        if name in data
    }
    content = known.get("content")
    known["type"] = FileType(data["type"])
    known["content"] = None if content is None else ContentType(content)
    return FileStat(**known)


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

    @field_validator("type")
    @classmethod
    def _v_type(cls, v: IndexType) -> IndexType:
        built = cls.model_fields["type"].default
        if v != built:
            raise ValueError(
                f"{cls.__name__} builds a {built.value!r} index, "
                f"not {v.value!r}; the class picks the store"
            )
        return v


class RedisIndexConfig(IndexConfig):
    type: IndexType = IndexType.REDIS
    url: str = "redis://localhost:6379/0"
    # None scopes the keys to the workspace; a prefix shares them with
    # every workspace that names it.
    key_prefix: str | None = None
