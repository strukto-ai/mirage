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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.postgres import client
from mirage.core.postgres.scope import ENTITY_FILES, KIND_DIRS, detect_scope
from mirage.errors.fs import enoent


async def schema_guard(
    accessor: PostgresAccessor, match: ScopeMatch, virtual: str
) -> None:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await client.list_schemas(conn, accessor.config.schemas)
    if match.slots["schema"] not in schemas:
        raise enoent(virtual)


async def entity_guard(
    accessor: PostgresAccessor, match: ScopeMatch, virtual: str
) -> None:
    schema = match.slots["schema"]
    kind = match.slots["kind"]
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        # An entity guard answers for its schema too: it replaces the
        # listing chain wherever it runs, so a table under a schema the
        # mount's `schemas` leaves out would otherwise read, stat and
        # list as if the mount could see it.
        if schema not in await client.list_schemas(
            conn, accessor.config.schemas
        ):
            raise enoent(virtual)
        if kind == "tables":
            names = await client.list_tables(conn, schema)
        else:
            views = await client.list_views(conn, schema)
            mviews = await client.list_matviews(conn, schema)
            names = sorted(set(views) | set(mviews))
    if match.slots["entity"] not in names:
        raise enoent(virtual)


async def entity_exists(
    accessor: PostgresAccessor, match: ScopeMatch, virtual: str
) -> bool:
    """Whether ``entity_guard`` admits the entity a match names.

    For the bespoke fast paths (``tail -n`` and ``wc -l`` on
    ``rows.jsonl``), which query the relation by the names in the path:
    they take the fast path only for an entity the mount can see, and
    otherwise hand the operand to the generic, which stats it through
    the same guard and reports it the way GNU names a missing file.

    Args:
        accessor (PostgresAccessor): backend handle.
        match (ScopeMatch): a match whose slots hold ``schema``, ``kind``
            and ``entity``.
        virtual (str): the operand's virtual path.
    """
    try:
        await entity_guard(accessor, match, virtual)
    except FileNotFoundError:
        return False
    return True


async def _list_root(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await client.list_schemas(conn, accessor.config.schemas)
    entries: list[tuple[str, IndexEntry]] = [
        (
            "database.json",
            IndexEntry(
                id="database.json",
                name="database.json",
                resource_type="postgres/database_json",
                vfs_name="database.json",
            ),
        )
    ]
    for s in schemas:
        entries.append(
            (
                s,
                IndexEntry(
                    id=s, name=s, resource_type="postgres/schema", vfs_name=s
                ),
            )
        )
    return entries


async def _list_schema(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    # tables/ and views/ exist by construction under every schema, the
    # same way the entity files below do under every entity.
    return [
        (
            name,
            IndexEntry(
                id=name,
                name=name,
                resource_type="postgres/kind",
                vfs_name=name,
            ),
        )
        for name in KIND_DIRS
    ]


async def _list_entities(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    schema = match.slots["schema"]
    kind = match.slots["kind"]
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            names = await client.list_tables(conn, schema)
        else:
            views = await client.list_views(conn, schema)
            mviews = await client.list_matviews(conn, schema)
            names = sorted(set(views) | set(mviews))
    return [
        (
            n,
            IndexEntry(
                id=n, name=n, resource_type=f"postgres/{kind[:-1]}", vfs_name=n
            ),
        )
        for n in names
    ]


async def _list_entity_files(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    return [
        (
            name,
            IndexEntry(
                id=name,
                name=name,
                resource_type="postgres/entity_file",
                vfs_name=name,
            ),
        )
        for name in ENTITY_FILES
    ]


readdir = make_readdir(
    detect_scope,
    listers={
        "root": _list_root,
        "schema": _list_schema,
        "kind": _list_entities,
        "entity": _list_entity_files,
    },
    # Every lister below answers from the path alone, so without these a
    # schema or entity that does not exist reads as a real directory:
    # tables/ and views/ under any first segment, the entity files under
    # any third, and an empty listing (not ENOENT) for a missing schema's
    # tables/. Same guards stat runs, so the two answer alike.
    guards={
        "schema": schema_guard,
        "kind": schema_guard,
        "entity": entity_guard,
    },
)
