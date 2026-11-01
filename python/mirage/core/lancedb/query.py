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

from typing import cast

import pyarrow as pa
from lancedb.query import AsyncQuery

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.lancedb.render import cell_text
from mirage.core.lancedb.types import LanceRow, ValueTest
from mirage.rs.stream import open_stream


def eq_clause(column: str, value: str) -> str:
    """Render an equality with Rust's shared Lance SQL quoting.

    Args:
        column (str): the configured column name.
        value (str): the literal value to match.
    """
    return (
        open_stream(
            "lance_query", {"op": "equal", "column": column, "value": value}
        )
        .finish()
        .decode()
    )


def _predicate(column: str, filters: dict[str, str], prefix: str) -> str:
    """Render group filters and a literal name prefix in Lance SQL.

    Args:
        column (str): the column the prefix applies to.
        filters (dict[str, str]): parent group equality filters.
        prefix (str): the literal name prefix, empty for none.
    """
    return (
        open_stream(
            "lance_query",
            {
                "op": "predicate",
                "column": column,
                "filters": [[key, value] for key, value in filters.items()],
                "prefix": prefix,
            },
        )
        .finish()
        .decode()
    )


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
    return cast(list[LanceRow], await query.to_list())


async def row_record(
    accessor: LanceDBAccessor, table: str, id_column: str, row_id: str
) -> LanceRow | None:
    tbl = await accessor.table(table)
    rows = (
        await tbl.query()
        .where(eq_clause(id_column, row_id))
        .limit(1)
        .to_list()
    )
    return rows[0] if rows else None


async def search_rows(
    accessor: LanceDBAccessor, table: str, query_text: str, limit: int
) -> list[LanceRow]:
    async def fetch() -> list[LanceRow]:
        tbl = await accessor.table(table)
        builder = await tbl.search(query_text)
        return cast(list[LanceRow], await builder.limit(limit).to_list())

    return await accessor.searches.get((table, query_text, limit), fetch)


async def text_columns(
    accessor: LanceDBAccessor, table: str, skipped: set[str]
) -> list[str] | None:
    """The string columns of a table's card, or None when a column the
    card renders is neither a string nor a scalar spelled in digits and
    signs (a list, a struct, bytes, a duration's ``2 days``), whose
    spelling a filter on strings cannot test.

    Args:
        accessor (LanceDBAccessor): the mount's accessor.
        table (str): the table.
        skipped (set[str]): the columns the card leaves out.
    """
    tbl = await accessor.table(table)
    schema = await tbl.schema()
    texts: list[str] = []
    for field in schema:
        if field.name in skipped:
            continue
        kind = field.type
        if pa.types.is_string(kind) or pa.types.is_large_string(kind):
            texts.append(field.name)
        elif not (
            pa.types.is_integer(kind)
            or pa.types.is_floating(kind)
            or pa.types.is_boolean(kind)
            or pa.types.is_decimal(kind)
            or pa.types.is_timestamp(kind)
            or pa.types.is_date(kind)
            or pa.types.is_time(kind)
            or pa.types.is_null(kind)
        ):
            return None
    return texts


def holding_clause(
    columns: list[str],
    texts: list[str],
    ignore_case: bool,
    filters: dict[str, str],
) -> str:
    """The where clause for rows whose string columns hold one of
    ``texts``, within a group's filters.

    Args:
        columns (list[str]): the string columns.
        texts (list[str]): ASCII letters and spaces, so no LIKE
            wildcard or quote needs escaping.
        ignore_case (bool): fold ASCII case.
        filters (dict[str, str]): the group's equality filters.
    """
    return (
        open_stream(
            "lance_query",
            {
                "op": "holding",
                "columns": list(columns),
                "texts": list(texts),
                "ignore_case": ignore_case,
                "filters": [[key, value] for key, value in filters.items()],
            },
        )
        .finish()
        .decode()
    )


async def rows_where(
    accessor: LanceDBAccessor,
    table: str,
    clause: str,
    columns: list[str],
    limit: int,
) -> list[LanceRow] | None:
    """Every row of ``table`` the clause keeps, ``columns`` selected, or
    None when more than ``limit`` do.

    Args:
        accessor (LanceDBAccessor): the mount's accessor.
        table (str): the table.
        clause (str): the where clause.
        columns (list[str]): the columns returned.
        limit (int): the most rows answered.
    """
    tbl = await accessor.table(table)
    rows: list[LanceRow] = []
    query = tbl.query().select(columns).where(clause).limit(limit + 1)
    async for batch in await query.to_batches():
        rows.extend(batch.to_pylist())
    return rows if len(rows) <= limit else None
