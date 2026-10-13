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

from bson import Timestamp
from bson.json_util import RELAXED_JSON_OPTIONS, dumps

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mongodb.client import (
    count_documents,
    find_documents,
    iter_documents,
    iter_inserts,
    operation_time,
)
from mirage.core.mongodb.readdir import entity_guard
from mirage.core.mongodb.scope import detect_scope, entity_kind
from mirage.core.mongodb.types import PRIMARY_KEY, EntityKind
from mirage.errors.fs import efbig, enoent
from mirage.types import PathSpec
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


async def last_lines(
    accessor: MongoDBAccessor,
    path: PathSpec,
    n: int,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes | None:
    """The last ``n`` documents of a collection or view, as its
    documents.jsonl renders them.

    Sorts by primary key descending with a limit instead of streaming
    the whole collection. ``max_doc_limit`` is the most documents one
    such read returns: a count past it that the collection could fill
    raises EFBIG. None for any other file.

    Args:
        accessor (MongoDBAccessor): Backend accessor.
        path (PathSpec): the file.
        n (int): Number of trailing documents, at least 1.
        index (IndexCacheStore): Unused; kept for reader-signature parity.
    """
    scope = detect_scope(path)
    if scope.kind != "documents":
        return None
    await entity_guard(accessor, scope, path.virtual)
    database, name = scope.slots["database"], scope.slots["name"]
    cap = accessor.config.max_doc_limit
    if (
        n > cap
        and await count_documents(accessor.client, database, name) > cap
    ):
        raise efbig(path)
    docs = await find_documents(
        accessor.client,
        database,
        name,
        sort=[(PRIMARY_KEY, -1)],
        limit=min(n, cap),
    )
    docs.reverse()
    if not docs:
        return b""
    elide = _elision_paths(accessor.config, database, name)
    lines = []
    for doc in docs:
        if elide:
            doc = _apply_elision(doc, elide)
        lines.append(render_doc(doc))
    return ("\n".join(lines) + "\n").encode()


async def line_count(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> int | None:
    """How many documents a collection or view holds, one line each in
    its documents.jsonl, by ``count_documents``. None for any other file.

    Args:
        accessor (MongoDBAccessor): Backend accessor.
        path (PathSpec): the file.
        index (IndexCacheStore): Unused; kept for reader-signature parity.
    """
    scope = detect_scope(path)
    if scope.kind != "documents":
        return None
    await entity_guard(accessor, scope, path.virtual)
    return await count_documents(
        accessor.client, scope.slots["database"], scope.slots["name"]
    )


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
    elide = _elision_paths(
        accessor.config, scope.slots["database"], scope.slots["name"]
    )
    async with aclosing(
        iter_documents(
            accessor.client,
            scope.slots["database"],
            scope.slots["name"],
            sort=[(PRIMARY_KEY, 1)],
            batch_size=batch_size,
        )
    ) as documents:
        async for doc in documents:
            if elide:
                doc = _apply_elision(doc, elide)
            yield (render_doc(doc) + "\n").encode()


async def follow(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes] | None:
    """The documents inserted into a collection from now on, one
    documents.jsonl line each, from a change stream. None for a view,
    which has no change stream, and for any other file.

    "Now" is the cluster's operation time when this returns: the stream
    opens when first read, after ``tail`` prints the last lines, and
    starts from that time, so nothing inserted in between is lost.

    Args:
        accessor (MongoDBAccessor): Backend accessor.
        path (PathSpec): the file.
        index (IndexCacheStore): Unused; kept for reader-signature parity.
    """
    scope = detect_scope(path)
    if (
        scope.kind != "documents"
        or entity_kind(scope) is not EntityKind.COLLECTION
    ):
        return None
    await entity_guard(accessor, scope, path.virtual)
    database = scope.slots["database"]
    after = await operation_time(accessor.client, database)
    return _inserted(accessor, database, scope.slots["name"], after)


async def _inserted(
    accessor: MongoDBAccessor,
    database: str,
    name: str,
    after: Timestamp | None,
) -> AsyncIterator[bytes]:
    """Each document inserted into the collection, rendered as a line.

    Args:
        accessor (MongoDBAccessor): Backend accessor.
        database (str): the database.
        name (str): the collection.
        after (Timestamp | None): the operation time they come after.
    """
    elide = _elision_paths(accessor.config, database, name)
    async for doc in iter_inserts(accessor.client, database, name, after):
        if elide:
            doc = _apply_elision(doc, elide)
        yield (render_doc(doc) + "\n").encode()
