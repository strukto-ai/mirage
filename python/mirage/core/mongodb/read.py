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

from bson.json_util import RELAXED_JSON_OPTIONS, dumps

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mongodb._client import database_exists, entity_exists
from mirage.core.mongodb._schema_json import (build_collection_schema_json,
                                              build_database_json)
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_stream
from mirage.core.mongodb.types import ScopeLevel
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    scope = detect_scope(path)
    if scope.level == ScopeLevel.DOCUMENTS:
        if not await entity_exists(accessor.client, accessor.config,
                                   scope.database, scope.name, scope.kind,
                                   accessor):
            raise enoent(path)
        chunks: list[bytes] = []
        async for chunk in read_stream(accessor, path, index):
            chunks.append(chunk)
        return b"".join(chunks)
    if scope.level == ScopeLevel.SCHEMA_JSON:
        if not await entity_exists(accessor.client, accessor.config,
                                   scope.database, scope.name, scope.kind,
                                   accessor):
            raise enoent(path)
        payload = await build_collection_schema_json(accessor, scope.database,
                                                     scope.name)
        return (dumps(payload, json_options=RELAXED_JSON_OPTIONS) +
                "\n").encode()
    if scope.level == ScopeLevel.DATABASE_JSON:
        if not await database_exists(accessor.client, accessor.config,
                                     scope.database, accessor):
            raise enoent(path)
        payload = await build_database_json(accessor, scope.database)
        return (dumps(payload, json_options=RELAXED_JSON_OPTIONS) +
                "\n").encode()
    raise enoent(path)
