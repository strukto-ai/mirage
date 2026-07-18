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

from typing import Any

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres import _client
from mirage.resource.secrets import reveal_secret


async def build_database_json(accessor: PostgresAccessor) -> dict[str, Any]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await _client.list_schemas(conn, accessor.config.schemas)
        tables: list[dict[str, Any]] = []
        views: list[dict[str, Any]] = []
        for s in schemas:
            for t in await _client.list_tables(conn, s):
                tables.append({
                    "schema":
                    s,
                    "name":
                    t,
                    "row_count_estimate":
                    await _client.estimated_row_count(conn, s, t),
                    "size_bytes_estimate":
                    await _client.table_size_bytes(conn, s, t),
                })
            for v in await _client.list_views(conn, s):
                views.append({"schema": s, "name": v, "kind": "view"})
            for v in await _client.list_matviews(conn, s):
                views.append({"schema": s, "name": v, "kind": "materialized"})
        relationships = await _client.fetch_all_relationships(conn, schemas)
    return {
        "database": _db_name_from_dsn(reveal_secret(accessor.config.dsn)),
        "schemas": schemas,
        "tables": tables,
        "views": views,
        "relationships": relationships,
    }


async def build_entity_schema_json(accessor: PostgresAccessor, schema: str,
                                   name: str, kind: str) -> dict[str, Any]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        cols = await _client.fetch_columns(conn, schema, name)
        pk = await _client.fetch_primary_key(conn, schema, name)
        fks = await _client.fetch_foreign_keys(conn, schema, name)
        idx = await _client.fetch_indexes(conn, schema, name)
        rows = await _client.estimated_row_count(conn, schema, name)
        size = await _client.table_size_bytes(conn, schema, name)
    pk_set = set(pk)
    fk_map: dict[str, dict[str, Any]] = {}
    for fk in fks:
        ref = fk["references"]
        for from_col, to_col in zip(fk["columns"], ref["columns"]):
            fk_map[from_col] = {
                "schema": ref["schema"],
                "table": ref["table"],
                "column": to_col,
            }
    for col in cols:
        if col["name"] in pk_set:
            col["primary_key"] = True
        if col["name"] in fk_map:
            col["references"] = fk_map[col["name"]]
    return {
        "schema": schema,
        "name": name,
        "kind": kind,
        "columns": cols,
        "primary_key": pk,
        "foreign_keys": fks,
        "indexes": idx,
        "row_count_estimate": rows,
        "size_bytes_estimate": size,
    }


def _db_name_from_dsn(dsn: str) -> str:
    return dsn.rstrip("/").rsplit("/", 1)[-1].split("?")[0] or "postgres"
