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

from bson.json_util import RELAXED_JSON_OPTIONS, dumps

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.mongodb._client import (find_documents, iter_documents,
                                         iter_inserts)
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.types import PRIMARY_KEY, ScopeLevel
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _apply_elision(value: dict, paths: set[str]) -> dict:
    grouped: dict[str, set[str]] = {}
    leaves: set[str] = set()
    for p in paths:
        head, _, tail = p.partition(".")
        if tail:
            grouped.setdefault(head, set()).add(tail)
        else:
            leaves.add(head)
    out: dict = {}
    for k, v in value.items():
        if k in leaves:
            continue
        if k in grouped and isinstance(v, dict):
            out[k] = _apply_elision(v, grouped[k])
        else:
            out[k] = v
    return out


def _elision_paths(config, database: str, name: str) -> set[str]:
    key = f"{database}.{name}"
    return set(config.elide_fields.get(key, []))


async def read_tail(
    accessor: MongoDBAccessor,
    path: PathSpec,
    n: int,
    index: IndexCacheStore = None,
) -> bytes:
    """Read only the last ``n`` documents of a collection.

    Pushes the tail into MongoDB (sort by primary key descending + limit)
    instead of streaming the whole collection.

    Args:
        accessor (MongoDBAccessor): Backend accessor.
        path (PathSpec): A documents.jsonl path; other scopes raise.
        n (int): Number of trailing documents to fetch.
        index (IndexCacheStore): Unused; kept for reader-signature parity.
    """
    scope = detect_scope(path)
    if scope.level != ScopeLevel.DOCUMENTS:
        raise enoent(path)
    limit = min(n, accessor.config.max_doc_limit)
    docs = await find_documents(
        accessor.client,
        scope.database,
        scope.name,
        sort=[(PRIMARY_KEY, -1)],
        limit=limit,
    )
    docs.reverse()
    if not docs:
        return b""
    elide = _elision_paths(accessor.config, scope.database, scope.name)
    lines = []
    for doc in docs:
        if elide:
            doc = _apply_elision(doc, elide)
        lines.append(dumps(doc, json_options=RELAXED_JSON_OPTIONS))
    return ("\n".join(lines) + "\n").encode()


async def read_stream(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    batch_size: int = 100,
) -> AsyncIterator[bytes]:
    scope = detect_scope(path)
    if scope.level != ScopeLevel.DOCUMENTS:
        raise enoent(path)
    elide = _elision_paths(accessor.config, scope.database, scope.name)
    async for doc in iter_documents(
            accessor.client,
            scope.database,
            scope.name,
            sort=[(PRIMARY_KEY, 1)],
            batch_size=batch_size,
    ):
        if elide:
            doc = _apply_elision(doc, elide)
        yield (dumps(doc, json_options=RELAXED_JSON_OPTIONS) + "\n").encode()


async def watch_stream(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> AsyncIterator[bytes]:
    scope = detect_scope(path)
    if scope.level != ScopeLevel.DOCUMENTS:
        raise enoent(path)
    elide = _elision_paths(accessor.config, scope.database, scope.name)
    async for doc in iter_inserts(accessor.client, scope.database, scope.name):
        if elide:
            doc = _apply_elision(doc, elide)
        yield (dumps(doc, json_options=RELAXED_JSON_OPTIONS) + "\n").encode()
