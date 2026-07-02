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

from mirage.resource.lancedb.config import LanceDBConfig
from mirage.types import PathSpec


class ScopeLevel(str, Enum):
    ROOT = "root"
    GROUP_DIR = "group_dir"
    ROW = "row"
    UNKNOWN = "unknown"


@dataclass
class LanceDBScope:
    level: ScopeLevel
    table: str | None = None
    filters: dict[str, str] = field(default_factory=dict)
    row_id: str | None = None
    blob: bool = False
    resource_path: str = "/"


def _parse_row_file(name: str,
                    config: LanceDBConfig) -> tuple[str, bool] | None:
    if name.endswith(".md"):
        return name[:-len(".md")], False
    if config.blob_column:
        suffix = "." + config.blob_ext
        if name.endswith(suffix):
            return name[:-len(suffix)], True
    return None


def detect_scope(path, config: LanceDBConfig) -> LanceDBScope:
    raw = path.mount_path if isinstance(path, PathSpec) else path
    key = raw.strip("/")
    segs = key.split("/") if key else []

    if config.table:
        table = config.table
        rest = segs
    else:
        if not segs:
            return LanceDBScope(level=ScopeLevel.ROOT, resource_path=raw)
        table = segs[0]
        rest = segs[1:]

    gb = config.group_by
    n = len(gb)

    if len(rest) <= n:
        filters = {gb[i]: rest[i] for i in range(len(rest))}
        return LanceDBScope(level=ScopeLevel.GROUP_DIR,
                            table=table,
                            filters=filters,
                            resource_path=raw)

    if len(rest) == n + 1:
        filters = {gb[i]: rest[i] for i in range(n)}
        parsed = _parse_row_file(rest[n], config)
        if parsed is not None:
            return LanceDBScope(level=ScopeLevel.ROW,
                                table=table,
                                filters=filters,
                                row_id=parsed[0],
                                blob=parsed[1],
                                resource_path=raw)

    return LanceDBScope(level=ScopeLevel.UNKNOWN, resource_path=raw)
