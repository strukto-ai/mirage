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

# The server error a snapshot read meets on a server outside a replica set.
NOT_A_REPLICA_SET = 123

# The server error a change stream meets on a server outside a replica set.
CHANGE_STREAM_UNSUPPORTED = 40573

# The server error a change stream meets resuming past what its history
# still holds.
HISTORY_LOST = 286

# The databases the server keeps for itself, never listed on a mount.
SYSTEM_DATABASES = frozenset({"admin", "local", "config"})

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
