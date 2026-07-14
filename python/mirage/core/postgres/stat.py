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

import hashlib

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.postgres import _client
from mirage.core.postgres.scope import detect_scope
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def stat(accessor: PostgresAccessor,
               path: PathSpec,
               index: IndexCacheStore | None = None) -> FileStat:
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.virtual
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    scope = detect_scope(
        PathSpec(virtual=raw,
                 directory=raw,
                 resource_path=mount_key(raw, prefix)))

    if scope.level == "root":
        return FileStat(name="/", type=FileType.DIRECTORY)

    if scope.level == "database_json":
        return FileStat(name="database.json", type=FileType.JSON)

    if scope.level == "schema":
        if not await _schema_exists(accessor, scope.schema):
            raise enoent(path)
        return FileStat(name=scope.schema,
                        type=FileType.DIRECTORY,
                        extra={"schema": scope.schema})

    if scope.level == "kind":
        if not await _schema_exists(accessor, scope.schema):
            raise enoent(path)
        return FileStat(name=scope.kind,
                        type=FileType.DIRECTORY,
                        extra={
                            "schema": scope.schema,
                            "kind": scope.kind
                        })

    if scope.level == "entity":
        if not await _entity_exists(accessor, scope.schema, scope.kind,
                                    scope.entity):
            raise enoent(path)
        return FileStat(name=scope.entity,
                        type=FileType.DIRECTORY,
                        extra={
                            "schema": scope.schema,
                            "kind": scope.kind,
                            "name": scope.entity
                        })

    if scope.level == "entity_schema":
        if not await _entity_exists(accessor, scope.schema, scope.kind,
                                    scope.entity):
            raise enoent(path)
        return FileStat(name="schema.json",
                        type=FileType.JSON,
                        extra={
                            "schema": scope.schema,
                            "kind": scope.kind,
                            "name": scope.entity
                        })

    if scope.level == "entity_rows":
        if not await _entity_exists(accessor, scope.schema, scope.kind,
                                    scope.entity):
            raise enoent(path)
        return await _rows_stat(accessor, scope.schema, scope.kind,
                                scope.entity)

    raise enoent(path)


async def _schema_exists(accessor: PostgresAccessor, schema: str) -> bool:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await _client.list_schemas(conn, accessor.config.schemas)
    return schema in schemas


async def _entity_exists(accessor: PostgresAccessor, schema: str, kind: str,
                         entity: str) -> bool:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            names = await _client.list_tables(conn, schema)
        else:
            views = await _client.list_views(conn, schema)
            mviews = await _client.list_matviews(conn, schema)
            names = sorted(set(views) | set(mviews))
    return entity in names


async def _rows_stat(accessor: PostgresAccessor, schema: str, kind: str,
                     entity: str) -> FileStat:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        cols = await _client.fetch_columns(conn, schema, entity)
        rows = await _client.estimated_row_count(conn, schema, entity)
        size = await _client.table_size_bytes(conn, schema, entity)
    fp_payload = orjson.dumps({"columns": cols, "rows": rows})
    fingerprint = hashlib.sha256(fp_payload).hexdigest()
    # size stays None: table_size_bytes is the on-disk storage size, not the
    # rendered JSONL length (FileStat.size must be render-derived or None,
    # see the CLAUDE.md FUSE rules). The storage size remains in extra.
    return FileStat(
        name="rows.jsonl",
        type=FileType.TEXT,
        size=None,
        fingerprint=fingerprint,
        extra={
            "schema": schema,
            "kind": kind,
            "name": entity,
            "row_count": rows,
            "size_bytes": size
        },
    )
