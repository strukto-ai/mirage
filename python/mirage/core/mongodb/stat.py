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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.mongodb._client import (count_documents, get_indexes,
                                          is_view)
from mirage.types import FileStat, FileType, PathSpec


def _is_single_db(config) -> bool:
    return config.databases is not None and len(config.databases) == 1


async def stat(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    """Get file stat for a path.

    Args:
        accessor (MongoDBAccessor): mongodb accessor.
        path (str): resource-relative path.
        index (IndexCacheStore | None): index cache.
        prefix (str): mount prefix for virtual index keys.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original

    if prefix and path.startswith(prefix):
        path = path[len(prefix):] or "/"
    key = path.strip("/")

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if any(p.startswith(".") for p in parts):
        raise FileNotFoundError(path)

    if _is_single_db(accessor.config) and len(
            parts) == 1 and parts[0].endswith(".jsonl"):
        db_name = accessor.config.databases[0]
        col_name = parts[0].removesuffix(".jsonl")
        return await _collection_stat(accessor, db_name, col_name, parts[0])

    if len(parts) == 1 and not parts[0].endswith(".jsonl"):
        return FileStat(
            name=parts[0],
            type=FileType.DIRECTORY,
            extra={"database": parts[0]},
        )

    if len(parts) == 2 and parts[1].endswith(".jsonl"):
        db_name = parts[0]
        col_name = parts[1].removesuffix(".jsonl")
        return await _collection_stat(accessor, db_name, col_name, parts[1])

    raise FileNotFoundError(path)


async def _collection_stat(
    accessor: MongoDBAccessor,
    db_name: str,
    col_name: str,
    filename: str,
) -> FileStat:
    view = await is_view(accessor.client, db_name, col_name)
    doc_count = await count_documents(accessor.client, db_name, col_name)
    if view:
        index_info: list[dict] = []
    else:
        indexes = await get_indexes(accessor.client, db_name, col_name)
        index_info = [{
            "name": idx.get("name"),
            "keys": dict(idx.get("key", {}))
        } for idx in indexes]
    return FileStat(
        name=filename,
        type=FileType.TEXT,
        extra={
            "database": db_name,
            "collection": col_name,
            "kind": "view" if view else "collection",
            "document_count": doc_count,
            "indexes": index_info,
        },
    )
