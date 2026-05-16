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

from mirage.core.mongodb.types import KIND_DIR_NAMES, EntityKind, ScopeLevel
from mirage.types import PathSpec


@dataclass
class MongoDBScope:
    level: ScopeLevel
    database: str | None = None
    kind: EntityKind | None = None
    name: str | None = None
    resource_path: str = "/"


def detect_scope(path) -> MongoDBScope:
    raw = path.strip_prefix if isinstance(path, PathSpec) else path
    key = raw.strip("/")

    if not key:
        return MongoDBScope(level=ScopeLevel.ROOT, resource_path="/")

    parts = key.split("/")

    if len(parts) == 1:
        return MongoDBScope(level=ScopeLevel.DATABASE,
                            database=parts[0],
                            resource_path=raw)

    if len(parts) == 2:
        db, leaf = parts
        if leaf == "database.json":
            return MongoDBScope(level=ScopeLevel.DATABASE_JSON,
                                database=db,
                                resource_path=raw)
        if leaf in KIND_DIR_NAMES:
            return MongoDBScope(level=ScopeLevel.KIND_DIR,
                                database=db,
                                kind=KIND_DIR_NAMES[leaf],
                                resource_path=raw)
        return MongoDBScope(level=ScopeLevel.UNKNOWN, resource_path=raw)

    if len(parts) == 3:
        db, kind_seg, name = parts
        if kind_seg in KIND_DIR_NAMES:
            return MongoDBScope(level=ScopeLevel.ENTITY,
                                database=db,
                                kind=KIND_DIR_NAMES[kind_seg],
                                name=name,
                                resource_path=raw)
        return MongoDBScope(level=ScopeLevel.UNKNOWN, resource_path=raw)

    if len(parts) == 4:
        db, kind_seg, name, leaf = parts
        if kind_seg in KIND_DIR_NAMES:
            kind = KIND_DIR_NAMES[kind_seg]
            if leaf == "schema.json":
                return MongoDBScope(level=ScopeLevel.SCHEMA_JSON,
                                    database=db,
                                    kind=kind,
                                    name=name,
                                    resource_path=raw)
            if leaf == "documents.jsonl":
                return MongoDBScope(level=ScopeLevel.DOCUMENTS,
                                    database=db,
                                    kind=kind,
                                    name=name,
                                    resource_path=raw)
        return MongoDBScope(level=ScopeLevel.UNKNOWN, resource_path=raw)

    return MongoDBScope(level=ScopeLevel.UNKNOWN, resource_path=raw)
