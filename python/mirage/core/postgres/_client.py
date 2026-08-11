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

import json
from typing import Any

import asyncpg

from mirage.utils.json_canonical import canonicalize_row, canonicalize_value

__all__ = ["canonicalize_row", "canonicalize_value"]


def quote_ident(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def qualified(schema: str, name: str) -> str:
    return f"{quote_ident(schema)}.{quote_ident(name)}"


async def list_schemas(conn: asyncpg.Connection,
                       allowlist: list[str] | None) -> list[str]:
    rows = await conn.fetch(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name NOT IN ('pg_catalog', 'information_schema') "
        "AND schema_name NOT LIKE 'pg_%' "
        "ORDER BY schema_name")
    names = [r["schema_name"] for r in rows]
    if allowlist is not None:
        names = [n for n in names if n in allowlist]
    return names


async def list_tables(conn: asyncpg.Connection, schema: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = $1 AND table_type = 'BASE TABLE' "
        "ORDER BY table_name", schema)
    return [r["table_name"] for r in rows]


async def list_views(conn: asyncpg.Connection, schema: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT table_name FROM information_schema.views "
        "WHERE table_schema = $1 "
        "ORDER BY table_name", schema)
    return [r["table_name"] for r in rows]


async def list_matviews(conn: asyncpg.Connection, schema: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT matviewname AS name FROM pg_matviews "
        "WHERE schemaname = $1 "
        "ORDER BY matviewname", schema)
    return [r["name"] for r in rows]


async def count_rows(conn: asyncpg.Connection, schema: str, name: str) -> int:
    return await conn.fetchval(
        f"SELECT COUNT(*) FROM {qualified(schema, name)}")


async def estimate_size(conn: asyncpg.Connection, schema: str,
                        name: str) -> tuple[int, int]:
    plan = await conn.fetchval(
        f"EXPLAIN (FORMAT JSON) SELECT * FROM {qualified(schema, name)}")
    if isinstance(plan, str):
        plan = json.loads(plan)
    top = plan[0]["Plan"]
    return int(top.get("Plan Rows", 0)), int(top.get("Plan Width", 0))


async def estimated_row_count(conn: asyncpg.Connection, schema: str,
                              name: str) -> int:
    val = await conn.fetchval(
        "SELECT reltuples::bigint FROM pg_class c "
        "JOIN pg_namespace n ON c.relnamespace = n.oid "
        "WHERE n.nspname = $1 AND c.relname = $2", schema, name)
    return int(val) if val is not None else 0


async def table_size_bytes(conn: asyncpg.Connection, schema: str,
                           name: str) -> int:
    val = await conn.fetchval(
        "SELECT pg_total_relation_size(c.oid) FROM pg_class c "
        "JOIN pg_namespace n ON c.relnamespace = n.oid "
        "WHERE n.nspname = $1 AND c.relname = $2", schema, name)
    return int(val) if val is not None else 0


async def fetch_rows(conn: asyncpg.Connection, schema: str, name: str, *,
                     limit: int, offset: int) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        f"SELECT * FROM {qualified(schema, name)} LIMIT $1 OFFSET $2", limit,
        offset)
    return [canonicalize_row(dict(r)) for r in rows]


async def fetch_columns(conn: asyncpg.Connection, schema: str,
                        name: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT column_name, data_type, is_nullable "
        "FROM information_schema.columns "
        "WHERE table_schema = $1 AND table_name = $2 "
        "ORDER BY ordinal_position", schema, name)
    return [{
        "name": r["column_name"],
        "type": r["data_type"],
        "nullable": r["is_nullable"] == "YES",
    } for r in rows]


async def fetch_table_comment(conn: asyncpg.Connection, schema: str,
                              name: str) -> str | None:
    return await conn.fetchval(
        "SELECT obj_description(c.oid, 'pg_class') "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = $1 AND c.relname = $2", schema, name)


async def fetch_column_comments(conn: asyncpg.Connection, schema: str,
                                name: str) -> dict[str, str]:
    rows = await conn.fetch(
        "SELECT a.attname, col_description(c.oid, a.attnum) AS comment "
        "FROM pg_class c "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "JOIN pg_attribute a "
        "  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped "
        "WHERE n.nspname = $1 AND c.relname = $2 "
        "ORDER BY a.attnum", schema, name)
    return {r["attname"]: r["comment"] for r in rows if r["comment"]}


async def fetch_enum_columns(conn: asyncpg.Connection, schema: str,
                             name: str) -> dict[str, dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT a.attname, t.typname, "
        "       array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] "
        "AS labels "
        "FROM pg_class c "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "JOIN pg_attribute a "
        "  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped "
        "JOIN pg_type t ON t.oid = a.atttypid "
        "JOIN pg_enum e ON e.enumtypid = t.oid "
        "WHERE n.nspname = $1 AND c.relname = $2 "
        "GROUP BY a.attname, t.typname", schema, name)
    return {
        r["attname"]: {
            "type": r["typname"],
            "labels": list(r["labels"]),
        }
        for r in rows
    }


async def fetch_column_stats(conn: asyncpg.Connection, schema: str,
                             name: str) -> dict[str, dict[str, Any]]:
    # pg_stats is populated by ANALYZE, so it is empty for a freshly written
    # relation until autovacuum gets to it. Callers treat it as best-effort;
    # mirage never runs ANALYZE itself (a write and a cost on the user's DB).
    rows = await conn.fetch(
        "SELECT attname, n_distinct, "
        "       most_common_vals::text::text[] AS mcv "
        "FROM pg_stats WHERE schemaname = $1 AND tablename = $2", schema, name)
    return {
        r["attname"]: {
            "n_distinct": float(r["n_distinct"]),
            "most_common_vals": list(r["mcv"]) if r["mcv"] else [],
        }
        for r in rows
    }


async def fetch_primary_key(conn: asyncpg.Connection, schema: str,
                            name: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT kcu.column_name "
        "FROM information_schema.table_constraints tc "
        "JOIN information_schema.key_column_usage kcu "
        "  ON tc.constraint_name = kcu.constraint_name "
        " AND tc.table_schema = kcu.table_schema "
        "WHERE tc.constraint_type = 'PRIMARY KEY' "
        "  AND tc.table_schema = $1 AND tc.table_name = $2 "
        "ORDER BY kcu.ordinal_position", schema, name)
    return [r["column_name"] for r in rows]


async def fetch_foreign_keys(conn: asyncpg.Connection, schema: str,
                             name: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT con.conname AS constraint_name, "
        "       a.attname AS from_column, "
        "       af.attname AS to_column, "
        "       k.ord, "
        "       nf.nspname AS to_schema, "
        "       cf.relname AS to_table "
        "FROM pg_constraint con "
        "JOIN pg_class c ON c.oid = con.conrelid "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "JOIN pg_class cf ON cf.oid = con.confrelid "
        "JOIN pg_namespace nf ON nf.oid = cf.relnamespace "
        "JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE "
        "JOIN unnest(con.confkey) WITH ORDINALITY AS kf(attnum, ord) "
        "  ON kf.ord = k.ord "
        "JOIN pg_attribute a "
        "  ON a.attrelid = con.conrelid AND a.attnum = k.attnum "
        "JOIN pg_attribute af "
        "  ON af.attrelid = con.confrelid AND af.attnum = kf.attnum "
        "WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 "
        "ORDER BY con.conname, k.ord", schema, name)
    grouped: dict[str, dict[str, Any]] = {}
    for r in rows:
        cn = r["constraint_name"]
        if cn not in grouped:
            grouped[cn] = {
                "columns": [],
                "references": {
                    "schema": r["to_schema"],
                    "table": r["to_table"],
                    "columns": [],
                },
            }
        grouped[cn]["columns"].append(r["from_column"])
        grouped[cn]["references"]["columns"].append(r["to_column"])
    return list(grouped.values())


async def fetch_indexes(conn: asyncpg.Connection, schema: str,
                        name: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT i.relname AS name, "
        "       ix.indisunique AS unique, "
        "       array_agg(a.attname ORDER BY x.ord) AS columns "
        "FROM pg_class t "
        "JOIN pg_namespace n ON t.relnamespace = n.oid "
        "JOIN pg_index ix ON ix.indrelid = t.oid "
        "JOIN pg_class i ON i.oid = ix.indexrelid "
        "JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord) ON TRUE "
        "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum "
        "WHERE n.nspname = $1 AND t.relname = $2 "
        "GROUP BY i.relname, ix.indisunique "
        "ORDER BY i.relname", schema, name)
    return [{
        "name": r["name"],
        "columns": list(r["columns"]),
        "unique": r["unique"],
    } for r in rows]


async def fetch_all_relationships(conn: asyncpg.Connection,
                                  schemas: list[str]) -> list[dict[str, Any]]:
    if not schemas:
        return []
    rows = await conn.fetch(
        "SELECT con.conname AS constraint_name, "
        "       n.nspname AS from_schema, "
        "       c.relname AS from_table, "
        "       a.attname AS from_column, "
        "       af.attname AS to_column, "
        "       k.ord, "
        "       nf.nspname AS to_schema, "
        "       cf.relname AS to_table "
        "FROM pg_constraint con "
        "JOIN pg_class c ON c.oid = con.conrelid "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "JOIN pg_class cf ON cf.oid = con.confrelid "
        "JOIN pg_namespace nf ON nf.oid = cf.relnamespace "
        "JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE "
        "JOIN unnest(con.confkey) WITH ORDINALITY AS kf(attnum, ord) "
        "  ON kf.ord = k.ord "
        "JOIN pg_attribute a "
        "  ON a.attrelid = con.conrelid AND a.attnum = k.attnum "
        "JOIN pg_attribute af "
        "  ON af.attrelid = con.confrelid AND af.attnum = kf.attnum "
        "WHERE con.contype = 'f' AND n.nspname = ANY($1::text[]) "
        "ORDER BY n.nspname, c.relname, con.conname, k.ord", schemas)
    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for r in rows:
        key = (r["from_schema"], r["from_table"], r["constraint_name"])
        if key not in grouped:
            grouped[key] = {
                "from": {
                    "schema": r["from_schema"],
                    "table": r["from_table"],
                    "columns": [],
                },
                "to": {
                    "schema": r["to_schema"],
                    "table": r["to_table"],
                    "columns": [],
                },
                "kind": "many_to_one",
            }
        grouped[key]["from"]["columns"].append(r["from_column"])
        grouped[key]["to"]["columns"].append(r["to_column"])
    return list(grouped.values())
