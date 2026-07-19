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

import re
from collections.abc import AsyncIterator
from typing import Any

from gridfs import AsyncGridFSBucket
from pymongo.asynchronous.collection import AsyncCollection
from pymongo.asynchronous.database import AsyncDatabase

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.utils import key_prefix as kp

# Newest revision of a filename wins; _id breaks uploadDate ties because
# ObjectIds are monotonic within a process.
LATEST_SORT = [("uploadDate", -1), ("_id", -1)]

_BATCH = 1000


def _key(path: str, config: GridFSConfig) -> str:
    return kp.apply(config.key_prefix or "", path)


def _prefix(path: str, config: GridFSConfig) -> str:
    return kp.apply_dir(config.key_prefix or "", path)


def _strip_prefix(key: str, config: GridFSConfig) -> str:
    return kp.strip(config.key_prefix or "", key)


def database(accessor: GridFSAccessor) -> AsyncDatabase[dict[str, Any]]:
    return accessor.client[accessor.config.database]


def files_coll(accessor: GridFSAccessor) -> AsyncCollection[dict[str, Any]]:
    return database(accessor)[f"{accessor.config.bucket}.files"]


def chunks_coll(accessor: GridFSAccessor) -> AsyncCollection[dict[str, Any]]:
    return database(accessor)[f"{accessor.config.bucket}.chunks"]


def bucket(accessor: GridFSAccessor) -> AsyncGridFSBucket:
    config = accessor.config
    if config.chunk_size_bytes is not None:
        return AsyncGridFSBucket(database(accessor),
                                 bucket_name=config.bucket,
                                 chunk_size_bytes=config.chunk_size_bytes)
    return AsyncGridFSBucket(database(accessor), bucket_name=config.bucket)


def prefix_query(pfx: str) -> dict[str, Any]:
    if not pfx:
        return {}
    return {"filename": {"$regex": "^" + re.escape(pfx)}}


async def latest_file(accessor: GridFSAccessor,
                      key: str) -> dict[str, Any] | None:
    return await files_coll(accessor).find_one({"filename": key},
                                               sort=LATEST_SORT)


async def iter_latest(accessor: GridFSAccessor,
                      query: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """Yield the newest revision of each filename matching a query.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        query (dict[str, Any]): fs.files filter; {} matches everything.

    Yields:
        dict[str, Any]: ``{"filename", "_id", "length", "uploadDate"}`` of
        the newest revision per filename, sorted by filename.
    """
    pipeline: list[dict[str, Any]] = [
        {
            "$match": query
        },
        {
            "$sort": {
                "filename": 1,
                "uploadDate": -1,
                "_id": -1
            }
        },
        {
            "$group": {
                "_id": "$filename",
                "fid": {
                    "$first": "$_id"
                },
                "length": {
                    "$first": "$length"
                },
                "uploadDate": {
                    "$first": "$uploadDate"
                },
            }
        },
        {
            "$sort": {
                "_id": 1
            }
        },
    ]
    cursor = await files_coll(accessor).aggregate(pipeline)
    async for doc in cursor:
        yield {
            "filename": doc["_id"],
            "_id": doc["fid"],
            "length": doc["length"],
            "uploadDate": doc["uploadDate"],
        }


async def delete_all(accessor: GridFSAccessor, query: dict[str, Any]) -> None:
    """Delete every revision (file doc + chunks) matching a query.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        query (dict[str, Any]): fs.files filter selecting docs to delete.
    """
    files = files_coll(accessor)
    chunks = chunks_coll(accessor)
    ids: list[Any] = []
    async for doc in files.find(query, projection={"_id": 1}):
        ids.append(doc["_id"])
    for i in range(0, len(ids), _BATCH):
        batch = ids[i:i + _BATCH]
        await chunks.delete_many({"files_id": {"$in": batch}})
        await files.delete_many({"_id": {"$in": batch}})
