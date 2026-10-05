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
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.search import LineMatcher, Searcher, query_matcher
from mirage.core.mongodb._schema_json import (
    build_collection_schema_json,
    build_database_json,
)
from mirage.core.mongodb.client import list_collections, list_databases
from mirage.core.mongodb.scope import entity_kind
from mirage.core.mongodb.stream import read_stream, render_doc
from mirage.core.mongodb.types import KIND_TO_DIR, EntityKind
from mirage.types import PathSpec
from mirage.vfs.types import SearchQuery

# A directory's answer is grep -r's over the files under it, spelled
# relative to the mount, in the order a walk visits them (sorted, so
# `collections/` < `database.json` < `views/`, and within an entity
# `documents.jsonl` < `schema.json`). Each file is rendered exactly as
# `cat` renders it and decided by the matcher grep compiles, which is the
# only answer a schemaless collection can prove: the server-side $regex
# this replaced saw only string fields found in a 100-document sample,
# folded case whatever -i said, skipped views and the metadata files,
# and stopped at `default_search_limit` documents per collection.


def _matched(rel: str, text: str, matcher: LineMatcher) -> list[str]:
    return [f"{rel}:{line}" for line in text.splitlines() if matcher(line)]


async def search_entity(
    accessor: MongoDBAccessor,
    database: str,
    kind: EntityKind,
    name: str,
    matcher: LineMatcher,
) -> list[str]:
    rel = f"{database}/{KIND_TO_DIR[kind]}/{name}"
    docs = f"{rel}/documents.jsonl"
    lines: list[str] = []
    async for chunk in read_stream(
        accessor,
        PathSpec(virtual="/" + docs, directory="/" + rel, vfs_path=docs),
    ):
        lines.extend(_matched(docs, chunk.decode(), matcher))
    schema = await build_collection_schema_json(accessor, database, name)
    return lines + _matched(f"{rel}/schema.json", render_doc(schema), matcher)


async def _kind_lines(
    accessor: MongoDBAccessor,
    database: str,
    kind: EntityKind,
    matcher: LineMatcher,
) -> list[str]:
    lines: list[str] = []
    for name in await list_collections(accessor.client, database, kind=kind):
        lines.extend(
            await search_entity(accessor, database, kind, name, matcher)
        )
    return lines


async def search_database(
    accessor: MongoDBAccessor, database: str, matcher: LineMatcher
) -> list[str]:
    payload = render_doc(await build_database_json(accessor, database))
    return (
        await _kind_lines(accessor, database, EntityKind.COLLECTION, matcher)
        + _matched(f"{database}/database.json", payload, matcher)
        + await _kind_lines(accessor, database, EntityKind.VIEW, matcher)
    )


async def _entity_searcher(
    accessor: MongoDBAccessor, match: ScopeMatch, query: SearchQuery
) -> list[str]:
    return await search_entity(
        accessor,
        match.slots["database"],
        entity_kind(match),
        match.slots["name"],
        query_matcher(query),
    )


async def _database_searcher(
    accessor: MongoDBAccessor, match: ScopeMatch, query: SearchQuery
) -> list[str]:
    return await search_database(
        accessor, match.slots["database"], query_matcher(query)
    )


async def _root_searcher(
    accessor: MongoDBAccessor, match: ScopeMatch, query: SearchQuery
) -> list[str]:
    matcher = query_matcher(query)
    lines: list[str] = []
    for database in await list_databases(accessor.client, accessor.config):
        lines.extend(await search_database(accessor, database, matcher))
    return lines


SEARCHERS: dict[str, Searcher[MongoDBAccessor]] = {
    "root": _root_searcher,
    "database": _database_searcher,
    "entity": _entity_searcher,
}
