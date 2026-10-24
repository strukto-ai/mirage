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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.core.gridfs.constants import TRASH_PREFIX
from mirage.utils import key_prefix as kp
from mirage.vfs.gridfs.config import GridFSConfig

# Newest revision of a filename wins; _id breaks uploadDate ties because
# ObjectIds are monotonic within a process.
LATEST_SORT = [("uploadDate", -1), ("_id", -1)]

# Each filename's revisions together, newest first, the order prune keeps
# them in.
PRUNE_SORT = [("filename", -1), ("uploadDate", -1), ("_id", -1)]

_BATCH = 1000


def _key(path: str, config: GridFSConfig) -> str:
    return kp.apply(config.key_prefix or "", path)


def database(accessor: GridFSAccessor) -> AsyncDatabase[dict[str, Any]]:
    return accessor.client[accessor.config.database]


def files_coll(accessor: GridFSAccessor) -> AsyncCollection[dict[str, Any]]:
    return database(accessor)[f"{accessor.config.bucket}.files"]


def chunks_coll(accessor: GridFSAccessor) -> AsyncCollection[dict[str, Any]]:
    return database(accessor)[f"{accessor.config.bucket}.chunks"]


def bucket(accessor: GridFSAccessor) -> AsyncGridFSBucket:
    config = accessor.config
    if config.chunk_size_bytes is not None:
        return AsyncGridFSBucket(
            database(accessor),
            bucket_name=config.bucket,
            chunk_size_bytes=config.chunk_size_bytes,
        )
    return AsyncGridFSBucket(database(accessor), bucket_name=config.bucket)


def prefix_query(pfx: str) -> dict[str, Any]:
    """Match the live revisions under a key prefix.

    Args:
        pfx (str): backend key prefix; ``""`` is the whole store, less
            the trash, which no mount key can reach.
    """
    if not pfx:
        return {"filename": {"$regex": "^(?!" + re.escape(TRASH_PREFIX) + ")"}}
    return {"filename": {"$regex": "^" + re.escape(pfx)}}


def trashed(key: str) -> str:
    """The filename ``rm`` moves a key's revisions to.

    Args:
        key (str): backend key, or a prefix of one.
    """
    return TRASH_PREFIX + key


async def latest_file(
    accessor: GridFSAccessor, key: str
) -> dict[str, Any] | None:
    return await files_coll(accessor).find_one(
        {"filename": key}, sort=LATEST_SORT
    )


async def iter_latest(
    accessor: GridFSAccessor, query: dict[str, Any]
) -> AsyncIterator[dict[str, Any]]:
    """Yield the newest revision of each filename matching a query.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        query (dict[str, Any]): fs.files filter; {} matches everything.

    Yields:
        dict[str, Any]: ``{"filename", "_id", "length", "uploadDate"}`` of
        the newest revision per filename, sorted by filename.
    """
    pipeline: list[dict[str, Any]] = [
        {"$match": query},
        {"$sort": {"filename": 1, "uploadDate": -1, "_id": -1}},
        {
            "$group": {
                "_id": "$filename",
                "fid": {"$first": "$_id"},
                "length": {"$first": "$length"},
                "uploadDate": {"$first": "$uploadDate"},
            }
        },
        {"$sort": {"_id": 1}},
    ]
    cursor = await files_coll(accessor).aggregate(pipeline)
    async for doc in cursor:
        yield {
            "filename": doc["_id"],
            "_id": doc["fid"],
            "length": doc["length"],
            "uploadDate": doc["uploadDate"],
        }


async def retag(
    accessor: GridFSAccessor,
    query: dict[str, Any],
    prefix: str,
    strip: str = "",
) -> int:
    """Rename every revision matching a query, in one server-side update.

    Each filename loses its leading ``strip`` and gains ``prefix``. Both are
    sent as literals and the server measures ``strip`` itself, so a ``$`` in
    a name is never read as a field path and the cut counts code points,
    as ``$substrCP`` does. The revisions keep their ``_id`` and chunks, so a
    read pinned to one still finds it under the new name.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        query (dict[str, Any]): fs.files filter selecting the revisions;
            every filename it selects starts with ``strip``.
        prefix (str): what the new filename starts with.
        strip (str): the leading part each old filename loses.

    Returns:
        int: how many revisions the query selected.
    """
    rest: Any = "$filename"
    if strip:
        rest = {
            "$substrCP": [
                "$filename",
                {"$strLenCP": {"$literal": strip}},
                {"$strLenCP": "$filename"},
            ]
        }
    result = await files_coll(accessor).update_many(
        query,
        [{"$set": {"filename": {"$concat": [{"$literal": prefix}, rest]}}}],
    )
    return result.matched_count


async def prune(accessor: GridFSAccessor, query: dict[str, Any]) -> None:
    """Delete the revisions past ``keep_revisions`` of each matching name.

    Args:
        accessor (GridFSAccessor): GridFS accessor; its config's
            ``keep_revisions`` is the number kept per filename, newest
            first, and ``None`` keeps them all.
        query (dict[str, Any]): fs.files filter naming the revisions to
            count, live or trashed.
    """
    keep = accessor.config.keep_revisions
    if keep is None:
        return
    # Streamed newest first within each filename and deleted in batches, so
    # no history, however long, is ever held in one document or one list.
    cursor = files_coll(accessor).find(
        query,
        projection={"_id": 1, "filename": 1},
        sort=PRUNE_SORT,
        allow_disk_use=True,
    )
    name: str | None = None
    kept = 0
    stale: list[Any] = []
    async for doc in cursor:
        if doc["filename"] != name:
            name, kept = doc["filename"], 0
        if kept < keep:
            kept += 1
            continue
        stale.append(doc["_id"])
        if len(stale) >= _BATCH:
            await delete_ids(accessor, stale)
            stale = []
    await delete_ids(accessor, stale)


async def delete_ids(accessor: GridFSAccessor, ids: list[Any]) -> None:
    """Delete revisions (file doc + chunks) by ``_id``.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        ids (list[Any]): the ``_id`` of each revision to delete.
    """
    files = files_coll(accessor)
    chunks = chunks_coll(accessor)
    for i in range(0, len(ids), _BATCH):
        batch = ids[i : i + _BATCH]
        await chunks.delete_many({"files_id": {"$in": batch}})
        await files.delete_many({"_id": {"$in": batch}})
