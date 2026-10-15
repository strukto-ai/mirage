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

import logging
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from typing import TYPE_CHECKING, Any

from bson import Timestamp
from pymongo import AsyncMongoClient
from pymongo.errors import OperationFailure, PyMongoError

from mirage.core.mongodb.types import (
    NOT_A_REPLICA_SET,
    SYSTEM_DATABASES,
    EntityKind,
)
from mirage.vfs.mongodb.config import MongoDBConfig

if TYPE_CHECKING:
    from mirage.accessor.mongodb import MongoDBAccessor

logger = logging.getLogger(__name__)


async def list_databases(
    client: AsyncMongoClient[Any], config: MongoDBConfig
) -> list[str]:
    all_dbs = await client.list_database_names()
    dbs = [d for d in all_dbs if d not in SYSTEM_DATABASES]
    if config.databases:
        dbs = [d for d in dbs if d in config.databases]
    return sorted(dbs)


async def list_collections(
    client: AsyncMongoClient[Any],
    database: str,
    kind: EntityKind | None = None,
) -> list[str]:
    db = client[database]
    filter_arg: dict[str, Any] | None = None
    if kind == EntityKind.COLLECTION:
        filter_arg = {"type": {"$ne": EntityKind.VIEW.value}}
    elif kind is not None:
        filter_arg = {"type": kind.value}
    return sorted(await db.list_collection_names(filter=filter_arg))


async def database_exists(
    client: AsyncMongoClient[Any],
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
    client: AsyncMongoClient[Any],
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
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
    filter: dict[str, Any] | None = None,
    projection: dict[str, Any] | None = None,
    sort: list[tuple[str, int]] | None = None,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    db = client[database]
    col = db[collection]
    cursor = col.find(filter or {}, projection)
    if sort:
        cursor = cursor.sort(sort)
    cursor = cursor.limit(limit)
    return await cursor.to_list(length=limit)


async def iter_documents(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
    filter: dict[str, Any] | None = None,
    projection: dict[str, Any] | None = None,
    sort: list[tuple[str, int]] | None = None,
    batch_size: int = 100,
) -> AsyncGenerator[dict[str, Any], None]:
    db = client[database]
    col = db[collection]
    cursor = col.find(filter or {}, projection)
    if sort:
        cursor = cursor.sort(sort)
    cursor = cursor.batch_size(batch_size)
    try:
        async for doc in cursor:
            yield doc
    finally:
        await cursor.close()


async def count_documents(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
    filter: dict[str, Any] | None = None,
) -> int:
    db = client[database]
    col = db[collection]
    return await col.count_documents(filter or {})


async def find_snapshot(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
    sort: list[tuple[str, int]],
    limit: int,
) -> tuple[list[dict[str, Any]], Timestamp] | None:
    """Documents read at one snapshot, and that snapshot's cluster time:
    a change stream started after it holds each insert the read does
    not, and none it does. None from a server outside a replica set,
    which takes no snapshot read and has no change stream.

    Args:
        client (AsyncMongoClient[Any]): the client.
        database (str): the database.
        collection (str): the collection.
        sort (list[tuple[str, int]]): the order to read in.
        limit (int): how many documents, at least 1.
    """
    db = client[database]
    try:
        reply = await db.command(
            "find",
            collection,
            sort=dict(sort),
            limit=limit,
            batchSize=limit,
            readConcern={"level": "snapshot"},
        )
    except OperationFailure as exc:
        if exc.code != NOT_A_REPLICA_SET:
            raise
        logger.debug("No snapshot read on %s: %s", database, exc)
        return None
    cursor = reply["cursor"]
    at = cursor["atClusterTime"]
    docs = list(cursor["firstBatch"])
    try:
        while cursor["id"]:
            reply = await db.command(
                "getMore", cursor["id"], collection=collection
            )
            cursor = reply["cursor"]
            docs.extend(cursor["nextBatch"])
    finally:
        # A failed or cancelled batch leaves the server cursor open.
        if cursor["id"]:
            try:
                await db.command(
                    "killCursors", collection, cursors=[cursor["id"]]
                )
            except PyMongoError:
                logger.debug("killCursors failed on %s", collection)
    return docs, at


async def iter_inserts(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
    after: Timestamp | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Each document inserted into a collection, from a change stream.

    Args:
        client (AsyncMongoClient[Any]): the client.
        database (str): the database.
        collection (str): the collection.
        after (Timestamp | None): the operation time the inserts come
            after, however late the stream opens; None for those after
            it opens.
    """
    col = client[database][collection]
    match: dict[str, Any] = {"operationType": "insert"}
    options: dict[str, Any] = {}
    if after is not None:
        match["clusterTime"] = {"$gt": after}
        options["start_at_operation_time"] = after
    async with await col.watch([{"$match": match}], **options) as stream:
        async for change in stream:
            doc = change.get("fullDocument")
            if doc is not None:
                yield doc


async def drain_changes(
    client: AsyncMongoClient[Any],
    database: str | None,
    token: Mapping[str, Any] | None,
    limit: int = 1000,
) -> tuple[list[dict[str, Any]], Mapping[str, Any] | None]:
    """The change events since ``token``, and the stream position after
    the last one taken.

    A stream opened with no token takes no events: it only marks the
    position a later drain starts after. One with a token is read until
    the server has no event ready, or ``limit`` of them, and resumes
    with ``start_after``, so a position past an invalidate (a watched
    database dropped) still opens a stream.

    Args:
        client (AsyncMongoClient[Any]): the client.
        database (str | None): the one database watched, None for the
            whole cluster.
        token (Mapping[str, Any] | None): the position the events come
            after, None for now.
        limit (int): the most events one drain takes.
    """
    target: Any = client if database is None else client[database]
    options: dict[str, Any] = {"show_expanded_events": True}
    if token is not None:
        options["start_after"] = token
    events: list[dict[str, Any]] = []
    async with await target.watch(**options) as stream:
        if token is None:
            await stream.try_next()
        while token is not None and len(events) < limit:
            event = await stream.try_next()
            if event is None:
                break
            events.append(event)
        return events, stream.resume_token


async def is_view(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
) -> bool:
    db = client[database]
    cursor = await db.list_collections(filter={"name": collection})
    async for spec in cursor:
        return spec.get("type") == EntityKind.VIEW
    return False


async def get_indexes(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
) -> list[dict[str, Any]]:
    if await is_view(client, database, collection):
        return []
    col = client[database][collection]
    indexes = []
    async for idx in await col.list_indexes():
        indexes.append(dict(idx))
    return indexes


async def get_validator(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
) -> dict[str, Any] | None:
    db = client[database]
    cursor = await db.list_collections(filter={"name": collection})
    async for spec in cursor:
        validator = spec.get("options", {}).get("validator", {})
        return validator.get("$jsonSchema")
    return None
