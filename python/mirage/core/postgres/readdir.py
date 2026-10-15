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
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.postgres import client
from mirage.core.postgres.scope import ENTITY_FILES, KIND_DIRS, detect_scope
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType


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


def _schema_extra(match: ScopeMatch) -> dict[str, str]:
    return {"schema": match.slots["schema"]}


def _kind_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "schema": match.slots["schema"],
        "kind": match.slots["kind"],
    }


def _entity_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "schema": match.slots["schema"],
        "kind": match.slots["kind"],
        "name": match.slots["entity"],
    }


# What each kind's stat carries in ``extra``, listed or not.
EXTRAS = {
    "schema": _schema_extra,
    "kind": _kind_extra,
    "entity": _entity_extra,
    "entity_schema": _entity_extra,
    "entity_semantic": _entity_extra,
    "entity_rows": _entity_extra,
}


def _dirs(names: list[str] | tuple[str, ...]) -> list[FileStat]:
    return [FileStat(name=name, type=FileType.DIRECTORY) for name in names]


async def _list_root(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[FileStat]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await client.list_schemas(conn, accessor.config.schemas)
    return [
        FileStat(name="database.json", type=FileType.FILE),
        *_dirs(schemas),
    ]


async def _list_schema(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[FileStat]:
    # tables/ and views/ exist by construction under every schema, the
    # same way the entity files below do under every entity.
    return _dirs(KIND_DIRS)


async def _list_entities(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[FileStat]:
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
    return _dirs(names)


async def _list_entity_files(
    accessor: PostgresAccessor, match: ScopeMatch
) -> list[FileStat]:
    return [FileStat(name=name, type=FileType.FILE) for name in ENTITY_FILES]


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
    extras=EXTRAS,
)
