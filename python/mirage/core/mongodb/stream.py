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

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from typing import Any

from bson.json_util import RELAXED_JSON_OPTIONS, dumps

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mongodb.client import (count_documents, find_documents,
                                        iter_documents, iter_inserts)
from mirage.core.mongodb.readdir import entity_guard
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.types import PRIMARY_KEY
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.json_canonical import canonicalize_value


def render_doc(doc: dict[str, Any]) -> str:
    return dumps(canonicalize_value(doc), json_options=RELAXED_JSON_OPTIONS)


def _apply_elision(value: dict[str, Any], paths: set[str]) -> dict[str, Any]:
    grouped: dict[str, set[str]] = {}
    leaves: set[str] = set()
    for p in paths:
        head, _, tail = p.partition(".")
        if tail:
            grouped.setdefault(head, set()).add(tail)
        else:
            leaves.add(head)
    out: dict[str, Any] = {}
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
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[bytes, bool]:
    """Read only the last ``n`` documents of a collection.

    Pushes the tail into MongoDB (sort by primary key descending + limit)
    instead of streaming the whole collection. ``max_doc_limit`` is the
    most documents one read may return; a count past it that the
    collection could fill returns the last ``max_doc_limit`` and says
    it stopped, where the ceiling used to stand in for the count in
    silence.

    Args:
        accessor (MongoDBAccessor): Backend accessor.
        path (PathSpec): A documents.jsonl path; other scopes raise.
        n (int): Number of trailing documents to fetch.
        index (IndexCacheStore): Unused; kept for reader-signature parity.

    Returns:
        tuple[bytes, bool]: the rendered documents, and whether the
            ceiling cut the count short.
    """
    scope = detect_scope(path)
    if scope.kind != "documents":
        raise enoent(path)
    await entity_guard(accessor, scope, path.virtual)
    cap = accessor.config.max_doc_limit
    limit = min(n, cap)
    stopped = n > cap and await count_documents(
        accessor.client, scope.slots["database"], scope.slots["name"]) > cap
    docs = await find_documents(
        accessor.client,
        scope.slots["database"],
        scope.slots["name"],
        sort=[(PRIMARY_KEY, -1)],
        limit=limit,
    )
    docs.reverse()
    if not docs:
        return b"", stopped
    elide = _elision_paths(accessor.config, scope.slots["database"],
                           scope.slots["name"])
    lines = []
    for doc in docs:
        if elide:
            doc = _apply_elision(doc, elide)
        lines.append(render_doc(doc))
    return ("\n".join(lines) + "\n").encode(), stopped


async def read_stream(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    batch_size: int = 100,
) -> AsyncGenerator[bytes, None]:
    scope = detect_scope(path)
    if scope.kind != "documents":
        raise enoent(path)
    # The entity guard is what applies the mount's `databases` filter;
    # this stream is the read_stream op, which a caller reaches without
    # a stat first (a redirect, a runtime's open), so it proves the
    # collection itself rather than trusting the names in the path.
    await entity_guard(accessor, scope, path.virtual)
    elide = _elision_paths(accessor.config, scope.slots["database"],
                           scope.slots["name"])
    async with aclosing(
            iter_documents(
                accessor.client,
                scope.slots["database"],
                scope.slots["name"],
                sort=[(PRIMARY_KEY, 1)],
                batch_size=batch_size,
            )) as documents:
        async for doc in documents:
            if elide:
                doc = _apply_elision(doc, elide)
            yield (render_doc(doc) + "\n").encode()


async def watch_stream(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    scope = detect_scope(path)
    if scope.kind != "documents":
        raise enoent(path)
    await entity_guard(accessor, scope, path.virtual)
    elide = _elision_paths(accessor.config, scope.slots["database"],
                           scope.slots["name"])
    async for doc in iter_inserts(accessor.client, scope.slots["database"],
                                  scope.slots["name"]):
        if elide:
            doc = _apply_elision(doc, elide)
        yield (render_doc(doc) + "\n").encode()
