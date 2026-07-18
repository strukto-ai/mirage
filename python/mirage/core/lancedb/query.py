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

from mirage.accessor.lancedb import LanceDBAccessor


def _quote(value: str) -> str:
    return value.replace("'", "''")


def _eq(column: str, value: str) -> str:
    text = str(value)
    if text.lstrip("-").isdigit():
        return f"{column} = {text}"
    return f"{column} = '{_quote(text)}'"


def _where(filters: dict[str, str]) -> str:
    return " AND ".join(_eq(col, val) for col, val in filters.items())


async def list_tables(accessor: LanceDBAccessor) -> list[str]:
    db = await accessor.db()
    result = await db.list_tables()
    names = result.tables if hasattr(result, "tables") else result
    return sorted(names)


async def table_exists(accessor: LanceDBAccessor, name: str) -> bool:
    return name in await list_tables(accessor)


async def distinct_values(accessor: LanceDBAccessor, table: str, column: str,
                          filters: dict[str, str], limit: int) -> list[str]:
    tbl = await accessor.table(table)
    query = tbl.query().select([column]).limit(limit)
    if filters:
        query = query.where(_where(filters))
    rows = await query.to_list()
    values = {str(row[column]) for row in rows if row.get(column) is not None}
    return sorted(values)


async def rows_matching(accessor: LanceDBAccessor, table: str,
                        filters: dict[str, str], columns: list[str],
                        limit: int) -> list[dict[str, Any]]:
    tbl = await accessor.table(table)
    query = tbl.query().select(columns).limit(limit)
    if filters:
        query = query.where(_where(filters))
    return await query.to_list()


async def row_record(accessor: LanceDBAccessor, table: str, id_column: str,
                     row_id: str) -> dict[str, Any] | None:
    tbl = await accessor.table(table)
    rows = await tbl.query().where(_eq(id_column, row_id)).limit(1).to_list()
    return rows[0] if rows else None


async def search_rows(accessor: LanceDBAccessor, table: str, query_text: str,
                      limit: int) -> list[dict[str, Any]]:
    key = (table, query_text, limit)
    cached = accessor.cached_search(key)
    if cached is not None:
        return cached
    tbl = await accessor.table(table)
    builder = await tbl.search(query_text)
    rows = await builder.limit(limit).to_list()
    accessor.store_search(key, rows)
    return rows
