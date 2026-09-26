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
from contextlib import aclosing

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mongodb._schema_json import (build_collection_schema_json,
                                              build_database_json)
from mirage.core.mongodb.readdir import database_guard, entity_guard
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_stream, render_doc
from mirage.types import PathSpec


async def _read_documents(accessor: MongoDBAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> bytes:
    chunks: list[bytes] = []
    async for chunk in read_stream(accessor, path, index):
        chunks.append(chunk)
    return b"".join(chunks)


async def _read_schema_json(accessor: MongoDBAccessor, match: ScopeMatch,
                            path: PathSpec, index: IndexCacheStore) -> bytes:
    await entity_guard(accessor, match, path.virtual)
    payload = await build_collection_schema_json(accessor,
                                                 match.slots["database"],
                                                 match.slots["name"])
    return (render_doc(payload) + "\n").encode()


async def _read_database_json(accessor: MongoDBAccessor, match: ScopeMatch,
                              path: PathSpec, index: IndexCacheStore) -> bytes:
    await database_guard(accessor, match, path.virtual)
    payload = await build_database_json(accessor, match.slots["database"])
    return (render_doc(payload) + "\n").encode()


read = make_read(
    detect_scope,
    readers={
        "documents": _read_documents,
        "schema_json": _read_schema_json,
        "database_json": _read_database_json,
    },
)


async def stream_any(
        accessor: MongoDBAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX) -> AsyncIterator[bytes]:
    """Serve every readable leaf through the same streaming interface.

    Args:
        accessor (MongoDBAccessor): backend handle.
        path (PathSpec): resolved file.
        index (IndexCacheStore): command-scoped listing cache.
    """
    if detect_scope(path).kind == "documents":
        async with aclosing(read_stream(accessor, path, index)) as stream:
            async for chunk in stream:
                yield chunk
    else:
        yield await read(accessor, path, index)
