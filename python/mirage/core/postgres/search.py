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

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres import _client

_TEXT_TYPES = (
    "text",
    "character varying",
    "character",
    "name",
    "uuid",
    "json",
    "jsonb",
)


async def _text_columns(conn, schema: str, name: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = $1 AND table_name = $2 "
        "AND data_type = ANY($3::text[]) "
        "ORDER BY ordinal_position", schema, name, list(_TEXT_TYPES))
    return [r["column_name"] for r in rows]


async def search_entity(accessor: PostgresAccessor, schema: str, kind: str,
                        entity: str, pattern: str,
                        limit: int) -> list[dict[str, Any]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        cols = await _text_columns(conn, schema, entity)
        if not cols:
            return []
        where = " OR ".join(f'"{c}"::text ILIKE $1' for c in cols)
        sql = f'SELECT * FROM "{schema}"."{entity}" WHERE {where} LIMIT $2'
        rows = await conn.fetch(sql, f"%{pattern}%", limit)
        return [dict(r) for r in rows]


async def search_kind(
        accessor: PostgresAccessor, schema: str, kind: str, pattern: str,
        limit: int) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            names = await _client.list_tables(conn, schema)
        else:
            views = await _client.list_views(conn, schema)
            mviews = await _client.list_matviews(conn, schema)
            names = sorted(set(views) | set(mviews))
    out: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for n in names:
        rows = await search_entity(accessor, schema, kind, n, pattern, limit)
        if rows:
            out.append((schema, kind, n, rows))
    return out


async def search_schema(
        accessor: PostgresAccessor, schema: str, pattern: str,
        limit: int) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    out: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for kind in ("tables", "views"):
        out.extend(await search_kind(accessor, schema, kind, pattern, limit))
    return out


async def search_database(
        accessor: PostgresAccessor, pattern: str,
        limit: int) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await _client.list_schemas(conn, accessor.config.schemas)
    out: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for s in schemas:
        out.extend(await search_schema(accessor, s, pattern, limit))
    return out


def format_grep_results(
        results: list[tuple[str, str, str, list[dict[str,
                                                     Any]]]]) -> list[str]:
    lines: list[str] = []
    for schema, kind, entity, rows in results:
        for r in rows:
            line = orjson.dumps(r, default=str).decode()
            lines.append(f"{schema}/{kind}/{entity}/rows.jsonl:{line}")
    return lines
