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

from enum import StrEnum


class ScopeLevel(StrEnum):
    ROOT = "root"
    DATABASE = "database"
    DATABASE_JSON = "database_json"
    KIND_DIR = "kind_dir"
    ENTITY = "entity"
    SCHEMA_JSON = "schema_json"
    DOCUMENTS = "documents"
    UNKNOWN = "unknown"


class EntityKind(StrEnum):
    COLLECTION = "collection"
    VIEW = "view"


class BsonTypeTag(StrEnum):
    BOOL = "bool"
    INT = "int"
    LONG = "long"
    DOUBLE = "double"
    STRING = "string"
    OBJECT_ID = "objectId"
    DECIMAL = "decimal"
    DATE = "date"
    TIMESTAMP = "timestamp"
    BINARY = "binary"
    REGEX = "regex"
    NULL = "null"
    OBJECT = "object"
    ARRAY = "array"
    UNKNOWN = "unknown"


class IndexType(StrEnum):
    BTREE = "btree"
    TEXT = "text"
    HASHED = "hashed"
    GEO_2D = "2d"
    GEO_2DSPHERE = "2dsphere"
    WILDCARD = "wildcard"


PRIMARY_KEY = "_id"

RESOURCE_TYPE_DATABASE = "mongodb/database"
RESOURCE_TYPE_COLLECTION = "mongodb/collection"
RESOURCE_TYPE_VIEW = "mongodb/view"

KIND_TO_DIR: dict[EntityKind, str] = {
    EntityKind.COLLECTION: "collections",
    EntityKind.VIEW: "views",
}

KIND_TO_RESOURCE_TYPE: dict[EntityKind, str] = {
    EntityKind.COLLECTION: RESOURCE_TYPE_COLLECTION,
    EntityKind.VIEW: RESOURCE_TYPE_VIEW,
}

KIND_DIR_NAMES: dict[str, EntityKind] = {v: k for k, v in KIND_TO_DIR.items()}
