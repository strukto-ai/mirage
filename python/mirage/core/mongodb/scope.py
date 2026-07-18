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
from typing import Literal, TypeAlias

from mirage.core.mongodb.types import KIND_DIR_NAMES, EntityKind, ScopeLevel
from mirage.types import PathSpec


@dataclass(frozen=True)
class MongoDBRootScope:
    resource_path: str = "/"
    level: Literal[ScopeLevel.ROOT] = field(default=ScopeLevel.ROOT,
                                            init=False)


@dataclass(frozen=True)
class MongoDBDatabaseScope:
    database: str
    resource_path: str
    level: Literal[ScopeLevel.DATABASE] = field(default=ScopeLevel.DATABASE,
                                                init=False)


@dataclass(frozen=True)
class MongoDBDatabaseJSONScope:
    database: str
    resource_path: str
    level: Literal[ScopeLevel.DATABASE_JSON] = field(
        default=ScopeLevel.DATABASE_JSON, init=False)


@dataclass(frozen=True)
class MongoDBKindScope:
    database: str
    kind: EntityKind
    resource_path: str
    level: Literal[ScopeLevel.KIND_DIR] = field(default=ScopeLevel.KIND_DIR,
                                                init=False)


@dataclass(frozen=True)
class MongoDBEntityScope:
    database: str
    kind: EntityKind
    name: str
    resource_path: str
    level: Literal[ScopeLevel.ENTITY] = field(default=ScopeLevel.ENTITY,
                                              init=False)


@dataclass(frozen=True)
class MongoDBSchemaScope:
    database: str
    kind: EntityKind
    name: str
    resource_path: str
    level: Literal[ScopeLevel.SCHEMA_JSON] = field(
        default=ScopeLevel.SCHEMA_JSON, init=False)


@dataclass(frozen=True)
class MongoDBDocumentsScope:
    database: str
    kind: EntityKind
    name: str
    resource_path: str
    level: Literal[ScopeLevel.DOCUMENTS] = field(default=ScopeLevel.DOCUMENTS,
                                                 init=False)


@dataclass(frozen=True)
class MongoDBUnknownScope:
    resource_path: str
    level: Literal[ScopeLevel.UNKNOWN] = field(default=ScopeLevel.UNKNOWN,
                                               init=False)


MongoDBScope: TypeAlias = (MongoDBRootScope | MongoDBDatabaseScope
                           | MongoDBDatabaseJSONScope | MongoDBKindScope
                           | MongoDBEntityScope | MongoDBSchemaScope
                           | MongoDBDocumentsScope | MongoDBUnknownScope)


def detect_scope(path: PathSpec) -> MongoDBScope:
    raw = path.mount_path
    key = raw.strip("/")

    if not key:
        return MongoDBRootScope(resource_path="/")

    parts = key.split("/")

    if len(parts) == 1:
        return MongoDBDatabaseScope(database=parts[0], resource_path=raw)

    if len(parts) == 2:
        db, leaf = parts
        if leaf == "database.json":
            return MongoDBDatabaseJSONScope(database=db, resource_path=raw)
        if leaf in KIND_DIR_NAMES:
            return MongoDBKindScope(database=db,
                                    kind=KIND_DIR_NAMES[leaf],
                                    resource_path=raw)
        return MongoDBUnknownScope(resource_path=raw)

    if len(parts) == 3:
        db, kind_seg, name = parts
        if kind_seg in KIND_DIR_NAMES:
            return MongoDBEntityScope(database=db,
                                      kind=KIND_DIR_NAMES[kind_seg],
                                      name=name,
                                      resource_path=raw)
        return MongoDBUnknownScope(resource_path=raw)

    if len(parts) == 4:
        db, kind_seg, name, leaf = parts
        if kind_seg in KIND_DIR_NAMES:
            kind = KIND_DIR_NAMES[kind_seg]
            if leaf == "schema.json":
                return MongoDBSchemaScope(database=db,
                                          kind=kind,
                                          name=name,
                                          resource_path=raw)
            if leaf == "documents.jsonl":
                return MongoDBDocumentsScope(database=db,
                                             kind=kind,
                                             name=name,
                                             resource_path=raw)
        return MongoDBUnknownScope(resource_path=raw)

    return MongoDBUnknownScope(resource_path=raw)
