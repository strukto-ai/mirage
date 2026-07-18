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

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, TypeAlias

from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import PathSpec


class ScopeLevel(str, Enum):
    ROOT = "root"
    GROUP_DIR = "group_dir"
    ROW = "row"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class QdrantRootScope:
    resource_path: str = "/"
    level: Literal[ScopeLevel.ROOT] = field(default=ScopeLevel.ROOT,
                                            init=False)


@dataclass(frozen=True)
class QdrantGroupScope:
    table: str
    filters: dict[str, str] = field(default_factory=dict)
    resource_path: str = "/"
    level: Literal[ScopeLevel.GROUP_DIR] = field(default=ScopeLevel.GROUP_DIR,
                                                 init=False)


@dataclass(frozen=True)
class QdrantRowScope:
    table: str
    row_id: str
    kind: str
    filters: dict[str, str] = field(default_factory=dict)
    resource_path: str = "/"
    level: Literal[ScopeLevel.ROW] = field(default=ScopeLevel.ROW, init=False)


@dataclass(frozen=True)
class QdrantUnknownScope:
    resource_path: str = "/"
    level: Literal[ScopeLevel.UNKNOWN] = field(default=ScopeLevel.UNKNOWN,
                                               init=False)


QdrantScope: TypeAlias = (QdrantRootScope | QdrantGroupScope | QdrantRowScope
                          | QdrantUnknownScope)


def _parse_row_file(name: str, config: QdrantConfig) -> tuple[str, str] | None:
    if name.endswith(".json"):
        return name[:-len(".json")], "json"
    if config.text_field and name.endswith(".txt"):
        return name[:-len(".txt")], "txt"
    if config.blob_field:
        suffix = "." + config.blob_ext
        if name.endswith(suffix):
            return name[:-len(suffix)], "blob"
    return None


def detect_scope(path: PathSpec, config: QdrantConfig) -> QdrantScope:
    raw = path.mount_path
    key = raw.strip("/")
    segs = key.split("/") if key else []

    if config.collection:
        table = config.collection
        rest = segs
    else:
        if not segs:
            return QdrantRootScope(resource_path=raw)
        table = segs[0]
        rest = segs[1:]

    gb = config.group_by
    n = len(gb)

    if len(rest) <= n:
        filters = {gb[i]: rest[i] for i in range(len(rest))}
        return QdrantGroupScope(table=table,
                                filters=filters,
                                resource_path=raw)

    if len(rest) == n + 1:
        filters = {gb[i]: rest[i] for i in range(n)}
        parsed = _parse_row_file(rest[n], config)
        if parsed is not None:
            return QdrantRowScope(table=table,
                                  filters=filters,
                                  row_id=parsed[0],
                                  kind=parsed[1],
                                  resource_path=raw)

    return QdrantUnknownScope(resource_path=raw)
