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

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from pymongo import AsyncMongoClient

from mirage.core.mongodb.types import EntityKind
from mirage.resource.mongodb.config import MongoDBConfig

if TYPE_CHECKING:
    from mirage.accessor.mongodb import MongoDBAccessor


async def list_databases(client: AsyncMongoClient,
                         config: MongoDBConfig) -> list[str]:
    all_dbs = await client.list_database_names()
    system_dbs = {"admin", "local", "config"}
    dbs = [d for d in all_dbs if d not in system_dbs]
    if config.databases:
        dbs = [d for d in dbs if d in config.databases]
    return sorted(dbs)


async def list_collections(
    client: AsyncMongoClient,
    database: str,
    kind: EntityKind | None = None,
) -> list[str]:
    db = client[database]
    filter_arg: dict | None = None
    if kind is not None:
        filter_arg = {"type": kind.value}
    return sorted(await db.list_collection_names(filter=filter_arg))


async def database_exists(
    client: AsyncMongoClient,
    config: MongoDBConfig,
    database: str,
    accessor: "MongoDBAccessor | None" = None,
) -> bool:
    if accessor is not None:
        dbs = await accessor.cached_list(
            "list_databases",
            lambda: list_databases(client, config),
        )
    else:
        dbs = await list_databases(client, config)
    return database in dbs


async def entity_exists(
    client: AsyncMongoClient,
    config: MongoDBConfig,
    database: str,
    name: str,
    kind: EntityKind | None = None,
    accessor: "MongoDBAccessor | None" = None,
) -> bool:
    if not await database_exists(client, config, database, accessor):
        return False
    if accessor is not None:
        suffix = kind.value if kind is not None else ""
        key = f"list_collections:{database}:{suffix}"
        names = await accessor.cached_list(
            key,
            lambda: list_collections(client, database, kind),
        )
    else:
        names = await list_collections(client, database, kind)
    return name in names


async def find_documents(
    client: AsyncMongoClient,
    database: str,
    collection: str,
    filter: dict | None = None,
    projection: dict | None = None,
    sort: list[tuple[str, int]] | None = None,
    limit: int = 1000,
) -> list[dict]:
    db = client[database]
    col = db[collection]
    cursor = col.find(filter or {}, projection)
    if sort:
        cursor = cursor.sort(sort)
    cursor = cursor.limit(limit)
    return await cursor.to_list(length=limit)


async def iter_documents(
    client: AsyncMongoClient,
    database: str,
    collection: str,
    filter: dict | None = None,
    projection: dict | None = None,
    sort: list[tuple[str, int]] | None = None,
    batch_size: int = 100,
) -> AsyncIterator[dict]:
    db = client[database]
    col = db[collection]
    cursor = col.find(filter or {}, projection)
    if sort:
        cursor = cursor.sort(sort)
    cursor = cursor.batch_size(batch_size)
    async for doc in cursor:
        yield doc


async def count_documents(
    client: AsyncMongoClient,
    database: str,
    collection: str,
    filter: dict | None = None,
) -> int:
    db = client[database]
    col = db[collection]
    return await col.count_documents(filter or {})


async def iter_inserts(
    client: AsyncMongoClient,
    database: str,
    collection: str,
) -> AsyncIterator[dict]:
    col = client[database][collection]
    pipeline = [{"$match": {"operationType": "insert"}}]
    async with await col.watch(pipeline) as stream:
        async for change in stream:
            doc = change.get("fullDocument")
            if doc is not None:
                yield doc


async def is_view(
    client: AsyncMongoClient,
    database: str,
    collection: str,
) -> bool:
    db = client[database]
    cursor = await db.list_collections(filter={"name": collection})
    async for spec in cursor:
        return spec.get("type") == EntityKind.VIEW
    return False


async def get_indexes(
    client: AsyncMongoClient,
    database: str,
    collection: str,
) -> list[dict]:
    if await is_view(client, database, collection):
        return []
    col = client[database][collection]
    indexes = []
    async for idx in await col.list_indexes():
        indexes.append(dict(idx))
    return indexes


async def get_validator(
    client: AsyncMongoClient,
    database: str,
    collection: str,
) -> dict | None:
    db = client[database]
    cursor = await db.list_collections(filter={"name": collection})
    async for spec in cursor:
        validator = spec.get("options", {}).get("validator", {})
        return validator.get("$jsonSchema")
    return None


async def get_index_stats(
    client: AsyncMongoClient,
    database: str,
    collection: str,
) -> dict[str, dict]:
    col = client[database][collection]
    out: dict[str, dict] = {}
    async for doc in await col.aggregate([{"$indexStats": {}}]):
        out[doc["name"]] = doc.get("accesses", {})
    return out
