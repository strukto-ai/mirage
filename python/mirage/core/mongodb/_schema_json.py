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

from typing import Any

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb._sampler import sample_field_types
from mirage.core.mongodb.client import (get_indexes, get_validator, is_view,
                                        list_collections)
from mirage.core.mongodb.types import PRIMARY_KEY, EntityKind, IndexType


def _index_type(idx: dict[str, Any]) -> str:
    if "textIndexVersion" in idx:
        return IndexType.TEXT
    return IndexType.BTREE


async def build_database_json(
    accessor: MongoDBAccessor,
    database: str,
) -> dict[str, Any]:
    collections = await list_collections(accessor.client,
                                         database,
                                         kind=EntityKind.COLLECTION)
    views = await list_collections(accessor.client,
                                   database,
                                   kind=EntityKind.VIEW)
    return {
        "database": database,
        "collections": [{
            "name": name
        } for name in collections],
        "views": [{
            "name": name
        } for name in views],
    }


async def build_collection_schema_json(
    accessor: MongoDBAccessor,
    database: str,
    collection: str,
    sample_size: int = 100,
) -> dict[str, Any]:
    col = accessor.client[database][collection]
    view = await is_view(accessor.client, database, collection)
    validator = await get_validator(accessor.client, database, collection)
    fields = await sample_field_types(col, sample_size=sample_size)
    if view:
        enriched_indexes: list[dict[str, Any]] = []
    else:
        indexes = await get_indexes(accessor.client, database, collection)
        enriched_indexes = [{
            "name": idx.get("name"),
            "keys": dict(idx.get("key", {})),
            "type": _index_type(idx),
        } for idx in indexes]
    return {
        "database": database,
        "name": collection,
        "kind": EntityKind.VIEW if view else EntityKind.COLLECTION,
        "validator": validator,
        "fields": fields,
        "primary_key": PRIMARY_KEY,
        "indexes": enriched_indexes,
        "sampled": sample_size,
    }
