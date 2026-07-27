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
from mirage.core.postgres._client import (canonicalize_row, qualified,
                                          quote_ident)
from mirage.core.postgres._schema_json import build_entity_schema_json
from mirage.core.postgres.semantic import build_entity_semantic_json

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


def _escape_like(pattern: str) -> str:
    """Escape LIKE/ILIKE wildcards so the pattern matches as a literal.

    Postgres LIKE treats % and _ as wildcards and \\ as the default escape
    char; grep's substring pattern has no such meaning, so `user_id` must not
    match `userXid`.

    Args:
        pattern (str): the literal substring to match.
    """
    return (pattern.replace("\\", "\\\\").replace("%",
                                                  "\\%").replace("_", "\\_"))


async def search_entity(
        accessor: PostgresAccessor,
        schema: str,
        kind: str,
        entity: str,
        pattern: str,
        limit: int,
        *,
        case_insensitive: bool = False) -> list[dict[str, Any]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        cols = await _text_columns(conn, schema, entity)
        if not cols:
            return []
        op = "ILIKE" if case_insensitive else "LIKE"
        where = " OR ".join(f"{quote_ident(c)}::text {op} $1" for c in cols)
        sql = (f"SELECT * FROM {qualified(schema, entity)} "
               f"WHERE {where} LIMIT $2")
        rows = await conn.fetch(sql, f"%{_escape_like(pattern)}%", limit)
        return [canonicalize_row(dict(r)) for r in rows]


async def search_entity_metadata(accessor: PostgresAccessor,
                                 schema: str,
                                 kind: str,
                                 entity: str,
                                 pattern: str,
                                 *,
                                 case_insensitive: bool = False) -> list[str]:
    """Grep an entity's rendered metadata files.

    The LIKE push-down only ever sees row values, so schema.json and
    semantic.json would be invisible at directory scope: `grep -r` would
    report "not found" for content that is plainly there. These documents
    are rendered, not stored, so the only honest way to match them is to
    render and scan. Matching mirrors grep: case-sensitive unless -i is set.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        kind (str): "tables" or "views".
        entity (str): the entity name.
        pattern (str): the literal substring to match.
        case_insensitive (bool): True when -i folds case.
    """
    entity_kind = "table" if kind == "tables" else "view"
    needle = pattern.lower() if case_insensitive else pattern
    docs = (
        ("schema.json", await build_entity_schema_json(accessor, schema,
                                                       entity, entity_kind)),
        ("semantic.json", await
         build_entity_semantic_json(accessor, schema, entity, entity_kind)),
    )
    lines: list[str] = []
    for name, doc in docs:
        rendered = orjson.dumps(doc, option=orjson.OPT_INDENT_2).decode()
        for line in rendered.splitlines():
            hay = line.lower() if case_insensitive else line
            if needle in hay:
                lines.append(f"{schema}/{kind}/{entity}/{name}:{line}")
    return lines


async def search_kind_metadata(accessor: PostgresAccessor,
                               schema: str,
                               kind: str,
                               pattern: str,
                               *,
                               case_insensitive: bool = False) -> list[str]:
    """Grep every entity's metadata files under one kind directory.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        kind (str): "tables" or "views".
        pattern (str): the literal substring to match.
        case_insensitive (bool): True when -i folds case.
    """
    names = await _entity_names(accessor, schema, kind)
    lines: list[str] = []
    for n in names:
        lines.extend(await
                     search_entity_metadata(accessor,
                                            schema,
                                            kind,
                                            n,
                                            pattern,
                                            case_insensitive=case_insensitive))
    return lines


async def search_schema_metadata(accessor: PostgresAccessor,
                                 schema: str,
                                 pattern: str,
                                 *,
                                 case_insensitive: bool = False) -> list[str]:
    """Grep metadata files across both kinds of one schema.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        pattern (str): the literal substring to match.
        case_insensitive (bool): True when -i folds case.
    """
    lines: list[str] = []
    for kind in ("tables", "views"):
        lines.extend(await
                     search_kind_metadata(accessor,
                                          schema,
                                          kind,
                                          pattern,
                                          case_insensitive=case_insensitive))
    return lines


async def search_database_metadata(
        accessor: PostgresAccessor,
        pattern: str,
        *,
        case_insensitive: bool = False) -> list[str]:
    """Grep metadata files across every visible schema.

    Args:
        accessor (PostgresAccessor): backend handle.
        pattern (str): the literal substring to match.
        case_insensitive (bool): True when -i folds case.
    """
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await _client.list_schemas(conn, accessor.config.schemas)
    lines: list[str] = []
    for s in schemas:
        lines.extend(await
                     search_schema_metadata(accessor,
                                            s,
                                            pattern,
                                            case_insensitive=case_insensitive))
    return lines


async def _entity_names(accessor: PostgresAccessor, schema: str,
                        kind: str) -> list[str]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            return await _client.list_tables(conn, schema)
        views = await _client.list_views(conn, schema)
        mviews = await _client.list_matviews(conn, schema)
        return sorted(set(views) | set(mviews))


async def search_kind(
    accessor: PostgresAccessor,
    schema: str,
    kind: str,
    pattern: str,
    limit: int,
    *,
    case_insensitive: bool = False
) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    names = await _entity_names(accessor, schema, kind)
    out: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for n in names:
        rows = await search_entity(accessor,
                                   schema,
                                   kind,
                                   n,
                                   pattern,
                                   limit,
                                   case_insensitive=case_insensitive)
        if rows:
            out.append((schema, kind, n, rows))
    return out


async def search_schema(
    accessor: PostgresAccessor,
    schema: str,
    pattern: str,
    limit: int,
    *,
    case_insensitive: bool = False
) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    out: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for kind in ("tables", "views"):
        out.extend(await search_kind(accessor,
                                     schema,
                                     kind,
                                     pattern,
                                     limit,
                                     case_insensitive=case_insensitive))
    return out


async def search_database(
    accessor: PostgresAccessor,
    pattern: str,
    limit: int,
    *,
    case_insensitive: bool = False
) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await _client.list_schemas(conn, accessor.config.schemas)
    out: list[tuple[str, str, str, list[dict[str, Any]]]] = []
    for s in schemas:
        out.extend(await search_schema(accessor,
                                       s,
                                       pattern,
                                       limit,
                                       case_insensitive=case_insensitive))
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
