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

import re

from lancedb.query import AsyncQuery

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.lancedb.render import cell_text
from mirage.core.lancedb.types import LanceRow, ValueTest

_INTEGER = re.compile(r"-?[0-9]+")


def _quote(value: str) -> str:
    return value.replace("'", "''")


def _column(name: str) -> str:
    """A configured column name, spelled so the parser reads a column.

    Backticks, not double quotes: lance reads a double-quoted word as a
    string literal, so ``"id" = 'x'`` compares the text ``id`` and
    matches nothing rather than failing. Quoting is what lets a name
    with a space or a reserved word through, and a bare name means the
    same thing quoted.

    Args:
        name (str): the column name as configured.
    """
    return "`" + name.replace("`", "``") + "`"


def _eq(column: str, value: str) -> str:
    text = str(value)
    if _INTEGER.fullmatch(text):
        return f"{_column(column)} = {text}"
    return f"{_column(column)} = '{_quote(text)}'"


def _where(filters: dict[str, str]) -> str:
    return " AND ".join(_eq(col, val) for col, val in filters.items())


def _like(column: str, prefix: str) -> str:
    escaped = prefix
    for ch in ("\\", "%", "_"):
        escaped = escaped.replace(ch, "\\" + ch)
    return (
        f"CAST({_column(column)} AS STRING) LIKE '{_quote(escaped)}%' "
        "ESCAPE '\\'"
    )


def _predicate(column: str, filters: dict[str, str], prefix: str) -> str:
    """The where clause for a group's filters plus a name prefix.

    The prefix is what a glob narrows the query to: the cap on rows is a
    window over the table, so filtering the head of it would hide every
    match past the cap, while a prefix match moves the window onto what
    the line asked for. LIKE has its own metacharacters, so ``%`` and
    ``_`` in the prefix are escaped rather than left to widen the match,
    and the cast is what lets a numeric id column take one.

    Args:
        column (str): the column the prefix applies to.
        filters (dict[str, str]): the group filters, if any.
        prefix (str): the literal name prefix, empty for no prefix.
    """
    parts = [_where(filters)] if filters else []
    if prefix and column:
        parts.append(_like(column, prefix))
    return " AND ".join(parts)


async def list_tables(accessor: LanceDBAccessor) -> list[str]:
    db = await accessor.db()
    result = await db.list_tables()
    names = result.tables if hasattr(result, "tables") else result
    return sorted(names)


async def table_exists(accessor: LanceDBAccessor, name: str) -> bool:
    return name in await list_tables(accessor)


async def _kept_texts(
    query: AsyncQuery, column: str, limit: int, keep: ValueTest
) -> list[str]:
    """The first ``limit`` values of ``column`` that pass ``keep``.

    Streams the unbounded query batch by batch and stops at the cap, so
    a scan past the head of the table costs one batch of memory.

    Args:
        query (AsyncQuery): the query, filtered and without a limit.
        column (str): the selected column.
        limit (int): how many kept values end the stream.
        keep (ValueTest): the test on each value's text.
    """
    texts: list[str] = []
    async for batch in await query.to_batches():
        for row in batch.to_pylist():
            value = row.get(column)
            if value is None:
                continue
            text = cell_text(value)
            if keep(text):
                texts.append(text)
                if len(texts) >= limit:
                    return texts
    return texts


async def distinct_values(
    accessor: LanceDBAccessor,
    table: str,
    column: str,
    filters: dict[str, str],
    limit: int,
    prefix: str = "",
    keep: ValueTest | None = None,
) -> list[str]:
    """The distinct values of one group column, as text.

    Without a test the limit bounds the rows, which is the ordinary
    capped listing over the head of the table. With one it bounds the
    MATCHES: the prefix a glob narrows the query to loses nothing, but
    it can let through rows the glob does not match (a head cut inside
    an escape pair decodes to a shorter value prefix) or narrow nothing
    at all (a head that is only the escape lead), and those rows would
    fill the cap and hide every match past it. A glob is a targeted
    request, so it pays a scan up to its matches where the plain
    listing pays one window.

    Args:
        accessor (LanceDBAccessor): the mount's accessor.
        table (str): the table to read.
        column (str): the group column.
        filters (dict[str, str]): the parent groups' equality filters.
        limit (int): the row cap.
        prefix (str): the literal value prefix a glob narrows to, empty
            for none.
        keep (ValueTest | None): the test on each value's text the cap
            counts, or None to cap the rows themselves.
    """
    tbl = await accessor.table(table)
    query = tbl.query().select([column])
    clause = _predicate(column, filters, prefix)
    if clause:
        query = query.where(clause)
    if keep is None:
        rows = await query.limit(limit).to_list()
        texts = [
            cell_text(row[column])
            for row in rows
            if row.get(column) is not None
        ]
    else:
        texts = await _kept_texts(query, column, limit, keep)
    return sorted(set(texts))


async def table_columns(accessor: LanceDBAccessor, table: str) -> list[str]:
    tbl = await accessor.table(table)
    schema = await tbl.schema()
    return list(schema.names)


async def rows_matching(
    accessor: LanceDBAccessor,
    table: str,
    filters: dict[str, str],
    columns: list[str],
    limit: int,
    id_column: str = "",
    prefix: str = "",
) -> list[LanceRow]:
    tbl = await accessor.table(table)
    query = tbl.query().select(columns).limit(limit)
    clause = _predicate(id_column, filters, prefix)
    if clause:
        query = query.where(clause)
    return await query.to_list()


async def row_record(
    accessor: LanceDBAccessor, table: str, id_column: str, row_id: str
) -> LanceRow | None:
    tbl = await accessor.table(table)
    rows = await tbl.query().where(_eq(id_column, row_id)).limit(1).to_list()
    return rows[0] if rows else None


async def search_rows(
    accessor: LanceDBAccessor, table: str, query_text: str, limit: int
) -> list[LanceRow]:
    key = (table, query_text, limit)
    cached = accessor.search_cache.get(key)
    if cached is not None:
        return cached
    tbl = await accessor.table(table)
    builder = await tbl.search(query_text)
    rows = await builder.limit(limit).to_list()
    accessor.search_cache[key] = rows
    return rows
