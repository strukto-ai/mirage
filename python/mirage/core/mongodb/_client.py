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

from motor.motor_asyncio import AsyncIOMotorClient

from mirage.resource.mongodb.config import MongoDBConfig


async def list_databases(client: AsyncIOMotorClient,
                         config: MongoDBConfig) -> list[str]:
    all_dbs = await client.list_database_names()
    system_dbs = {"admin", "local", "config"}
    dbs = [d for d in all_dbs if d not in system_dbs]
    if config.databases:
        dbs = [d for d in dbs if d in config.databases]
    return sorted(dbs)


async def list_collections(client: AsyncIOMotorClient,
                           database: str) -> list[str]:
    db = client[database]
    return sorted(await db.list_collection_names())


async def find_documents(
    client: AsyncIOMotorClient,
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
    client: AsyncIOMotorClient,
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
    client: AsyncIOMotorClient,
    database: str,
    collection: str,
    filter: dict | None = None,
) -> int:
    db = client[database]
    col = db[collection]
    return await col.count_documents(filter or {})


async def get_indexes(
    client: AsyncIOMotorClient,
    database: str,
    collection: str,
) -> list[dict]:
    db = client[database]
    col = db[collection]
    indexes = []
    async for idx in col.list_indexes():
        indexes.append(idx)
    return indexes
