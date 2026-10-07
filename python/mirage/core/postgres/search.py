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

from functools import partial

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.commands.builtin.grep_pushdown import grep_search_options
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.search import Searcher, query_matcher
from mirage.core.postgres import client
from mirage.core.postgres._schema_json import build_entity_schema_json
from mirage.core.postgres.client import (
    canonicalize_row,
    qualified,
    quote_ident,
)
from mirage.core.postgres.read import read_rows, row_line
from mirage.core.postgres.semantic import build_entity_semantic_json
from mirage.errors.fs import efbig
from mirage.types import PathSpec
from mirage.vfs.types import SearchQuery, SearchResult

# Column types whose `::text` is the value exactly as a rows.jsonl line
# spells it, so a LIKE over the cast finds every row whose line holds
# the pattern inside that value. Everything else renders differently in
# the line (a timestamp's separator, a float's digits, a `char(n)`'s
# padding, json's spacing), and a table holding one is not searchable.
_SAME_TEXT_TYPES = frozenset(
    {
        "text",
        "character varying",
        "name",
        "uuid",
        "smallint",
        "integer",
        "bigint",
        "boolean",
    }
)
# The ones that can hold a control character, which the line spells as
# an escape (`\n`, `\u0001`), so a pattern can match the escape's letters
# in a row whose value never holds them: such rows are candidates too.
_STRING_TYPES = frozenset({"text", "character varying", "name"})
# What a line spells around and between values: a pattern holding one
# can match where no single value holds it (`:4` after a key).
_STRUCTURAL = frozenset('"\\:,{}')
# How a NULL spells in the line; no LIKE over a NULL ever matches it.
_NULL = "null"


def _escape_like(pattern: str) -> str:
    """Escape LIKE/ILIKE wildcards so the pattern matches as a literal.

    Postgres LIKE treats % and _ as wildcards and \\ as the default escape
    char; grep's substring pattern has no such meaning, so `user_id` must not
    match `userXid`.

    Args:
        pattern (str): the literal substring to match.
    """
    return (
        pattern.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )


def _answerable(columns: list[tuple[str, str]], query: SearchQuery) -> bool:
    """Whether a LIKE over the columns finds every row a scan would.

    The push-down prints what grep over rows.jsonl would print, and a
    LIKE per column sees only values: a pattern that can match a key
    (every row holds every key), the text between values, a NULL's
    ``null`` or a value the line spells differently from its cast would
    be found by the scan and missed by the query. Any of those, and the
    wrapper scans instead of answering short.

    Args:
        columns (list[tuple[str, str]]): the entity's ``(name, data type)``
            in column order.
        query (SearchQuery): the qualified request; a literal pattern.
    """
    pattern = query.query
    if any(ch in _STRUCTURAL or ord(ch) < 0x20 for ch in pattern):
        return False
    folded = (
        pattern.lower() if grep_search_options(query).ignore_case else pattern
    )
    if folded in _NULL:
        return False
    for name, data_type in columns:
        if data_type not in _SAME_TEXT_TYPES:
            return False
        key = name.lower() if grep_search_options(query).ignore_case else name
        if folded in key:
            return False
    return True


async def search_entity(
    accessor: PostgresAccessor,
    schema: str,
    kind: str,
    entity: str,
    query: SearchQuery,
) -> list[str]:
    """The rows.jsonl lines of one entity that grep would print.

    When the columns and the pattern let a LIKE see every match
    (``_answerable``), the query picks candidates (a value holding the
    pattern, or one holding a control character the line escapes) and
    the matcher grep compiles decides each candidate's line. Otherwise
    the file is read and scanned the way ``cat | grep`` would, through
    the same read and its size guard, so a table too large to read is
    refused rather than answered short. There is no result cap: the
    push-down used to stop at ``default_search_limit`` rows and print
    those as grep's whole answer; past ``max_read_rows`` candidates it
    now refuses with EFBIG, as a whole read of that many rows is refused.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        kind (str): "tables" or "views".
        entity (str): the entity name.
        query (SearchQuery): the qualified request.

    Raises:
        FileTooLargeError: more rows match than one read may return.
    """
    cap = accessor.config.max_read_rows
    rows_path = f"{schema}/{kind}/{entity}/rows.jsonl"
    matcher = query_matcher(query)
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        columns = [
            (c["name"], c["type"])
            for c in await client.fetch_columns(conn, schema, entity)
        ]
        if not columns:
            return []
        if _answerable(columns, query):
            op = "ILIKE" if grep_search_options(query).ignore_case else "LIKE"
            clauses = [
                f"{quote_ident(name)}::text {op} $1" for name, _ in columns
            ]
            clauses += [
                f"{quote_ident(name)} ~ '[[:cntrl:]]'"
                for name, data_type in columns
                if data_type in _STRING_TYPES
            ]
            sql = (
                f"SELECT * FROM {qualified(schema, entity)} "
                f"WHERE {' OR '.join(clauses)} LIMIT $2"
            )
            max_bytes = accessor.config.max_read_bytes
            rows = await client.fetch_bounded_query(
                conn,
                sql,
                [f"%{_escape_like(query.query)}%", cap + 1],
                {name for name, _ in columns},
                max_bytes,
            )
            if rows is None or len(rows) > cap:
                raise efbig(rows_path)
            lines: list[str] = []
            rendered_bytes = 0
            for row in rows:
                line = row_line(canonicalize_row(dict(row)))
                rendered_bytes += len(line.encode()) + 1
                if rendered_bytes > max_bytes:
                    raise efbig(rows_path)
                if matcher(line):
                    lines.append(line)
            return lines
    data = await read_rows(accessor, schema, entity, path=rows_path)
    return [line for line in data.decode().split("\n")[:-1] if matcher(line)]


async def search_entity_metadata(
    accessor: PostgresAccessor,
    schema: str,
    kind: str,
    entity: str,
    query: SearchQuery,
) -> list[SearchResult]:
    """Grep an entity's rendered metadata files.

    The LIKE push-down only ever sees row values, so schema.json and
    semantic.json would be invisible at directory scope: `grep -r` would
    report "not found" for content that is plainly there. These documents
    are rendered, not stored, so the only honest way to match them is to
    render and scan, with the matcher grep itself compiles.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        kind (str): "tables" or "views".
        entity (str): the entity name.
        query (SearchQuery): the qualified request.
    """
    entity_kind = "table" if kind == "tables" else "view"
    matcher = query_matcher(query)
    docs = (
        (
            "schema.json",
            await build_entity_schema_json(
                accessor, schema, entity, entity_kind
            ),
        ),
        (
            "semantic.json",
            await build_entity_semantic_json(
                accessor, schema, entity, entity_kind
            ),
        ),
    )
    lines: list[SearchResult] = []
    for name, doc in docs:
        rendered = orjson.dumps(doc, option=orjson.OPT_INDENT_2).decode()
        for line in rendered.splitlines():
            if matcher(line):
                lines.append(
                    (
                        PathSpec.from_str_path(
                            f"/{schema}/{kind}/{entity}/{name}"
                        ),
                        f"{schema}/{kind}/{entity}/{name}:{line}",
                    )
                )
    return lines


async def search_kind_metadata(
    accessor: PostgresAccessor, schema: str, kind: str, query: SearchQuery
) -> list[SearchResult]:
    """Grep every entity's metadata files under one kind directory.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        kind (str): "tables" or "views".
        query (SearchQuery): the qualified request.
    """
    names = await _entity_names(accessor, schema, kind)
    lines: list[SearchResult] = []
    for n in names:
        lines.extend(
            await search_entity_metadata(accessor, schema, kind, n, query)
        )
    return lines


async def search_schema_metadata(
    accessor: PostgresAccessor, schema: str, query: SearchQuery
) -> list[SearchResult]:
    """Grep metadata files across both kinds of one schema.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        query (SearchQuery): the qualified request.
    """
    lines: list[SearchResult] = []
    for kind in ("tables", "views"):
        lines.extend(await search_kind_metadata(accessor, schema, kind, query))
    return lines


async def search_database_metadata(
    accessor: PostgresAccessor, query: SearchQuery
) -> list[SearchResult]:
    """Grep metadata files across every visible schema.

    Args:
        accessor (PostgresAccessor): backend handle.
        query (SearchQuery): the qualified request.
    """
    lines: list[SearchResult] = []
    for s in await _schemas(accessor):
        lines.extend(await search_schema_metadata(accessor, s, query))
    return lines


async def _schemas(accessor: PostgresAccessor) -> list[str]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        return await client.list_schemas(conn, accessor.config.schemas)


async def _entity_names(
    accessor: PostgresAccessor, schema: str, kind: str
) -> list[str]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            return await client.list_tables(conn, schema)
        views = await client.list_views(conn, schema)
        mviews = await client.list_matviews(conn, schema)
        return sorted(set(views) | set(mviews))


EntityLines = tuple[str, str, str, list[str]]


async def search_kind(
    accessor: PostgresAccessor, schema: str, kind: str, query: SearchQuery
) -> list[EntityLines]:
    """Every entity's matching rows under one kind directory.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        kind (str): "tables" or "views".
        query (SearchQuery): the qualified request.
    """
    out: list[EntityLines] = []
    for n in await _entity_names(accessor, schema, kind):
        lines = await search_entity(accessor, schema, kind, n, query)
        if lines:
            out.append((schema, kind, n, lines))
    return out


async def search_schema(
    accessor: PostgresAccessor, schema: str, query: SearchQuery
) -> list[EntityLines]:
    """Matching rows across both kinds of one schema.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        query (SearchQuery): the qualified request.
    """
    out: list[EntityLines] = []
    for kind in ("tables", "views"):
        out.extend(await search_kind(accessor, schema, kind, query))
    return out


async def search_database(
    accessor: PostgresAccessor, query: SearchQuery
) -> list[EntityLines]:
    """Matching rows across every visible schema.

    Args:
        accessor (PostgresAccessor): backend handle.
        query (SearchQuery): the qualified request.
    """
    out: list[EntityLines] = []
    for s in await _schemas(accessor):
        out.extend(await search_schema(accessor, s, query))
    return out


def format_grep_results(results: list[EntityLines]) -> list[SearchResult]:
    return [
        (
            PathSpec.from_str_path(f"/{schema}/{kind}/{entity}/rows.jsonl"),
            f"{schema}/{kind}/{entity}/rows.jsonl:{line}",
        )
        for schema, kind, entity, lines in results
        for line in lines
    ]


# Directory scopes cover every file under them, so the rendered
# schema.json / semantic.json are searched alongside the row push-down.
# Deliberate divergence from GNU: rows come first and metadata second,
# rather than in per-entity readdir order.
async def _root_searcher(
    accessor: PostgresAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    return format_grep_results(
        await search_database(accessor, query)
    ) + await search_database_metadata(accessor, query)


async def _schema_searcher(
    accessor: PostgresAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    schema = match.slots["schema"]
    return format_grep_results(
        await search_schema(accessor, schema, query)
    ) + await search_schema_metadata(accessor, schema, query)


async def _kind_searcher(
    accessor: PostgresAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    schema = match.slots["schema"]
    kind = match.slots["kind"]
    return format_grep_results(
        await search_kind(accessor, schema, kind, query)
    ) + await search_kind_metadata(accessor, schema, kind, query)


async def _entity_lines(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    query: SearchQuery,
    metadata: bool,
) -> list[SearchResult]:
    schema = match.slots["schema"]
    kind = match.slots["kind"]
    entity = match.slots["entity"]
    lines = await search_entity(accessor, schema, kind, entity, query)
    found = format_grep_results([(schema, kind, entity, lines)])
    # entity_rows names rows.jsonl explicitly; only the directory scope
    # pulls in the sibling metadata files.
    if metadata:
        found += await search_entity_metadata(
            accessor, schema, kind, entity, query
        )
    return found


_entity_searcher = partial(_entity_lines, metadata=True)
_rows_searcher = partial(_entity_lines, metadata=False)

SEARCHERS: dict[str, Searcher[PostgresAccessor]] = {
    "root": _root_searcher,
    "schema": _schema_searcher,
    "kind": _kind_searcher,
    "entity": _entity_searcher,
    "entity_rows": _rows_searcher,
}
