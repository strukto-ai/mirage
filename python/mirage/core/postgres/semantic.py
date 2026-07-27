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

SAMPLE_VALUES_LIMIT = 10

TIME_TYPES = frozenset({
    "date",
    "time without time zone",
    "time with time zone",
    "timestamp without time zone",
    "timestamp with time zone",
})

NUMERIC_TYPES = frozenset({
    "bigint",
    "double precision",
    "integer",
    "money",
    "numeric",
    "real",
    "smallint",
})


def classify_column(name: str, data_type: str, key_columns: set[str]) -> str:
    """Assign a column its semantic role.

    Mirrors the dimension / time_dimension / fact split of the Snowflake
    semantic view vocabulary. Keys stay dimensions even when numeric: an
    id is something you group or join by, never something you sum.

    Args:
        name (str): column name.
        data_type (str): the information_schema data type.
        key_columns (set[str]): primary-key and foreign-key column names.
    """
    if name in key_columns:
        return "dimensions"
    if data_type in TIME_TYPES:
        return "time_dimensions"
    if data_type in NUMERIC_TYPES:
        return "facts"
    return "dimensions"


def build_column_entry(column: dict[str, Any], comment: str | None,
                       enum: dict[str, Any] | None,
                       stats: dict[str, Any] | None) -> dict[str, Any]:
    """Render one column in the semantic vocabulary.

    Empty fields are omitted rather than emitted as null. The whole point
    of this artifact is to fit an agent's context budget, so absent
    metadata should cost nothing.

    Args:
        column (dict[str, Any]): the entry from fetch_columns.
        comment (str | None): the column's COMMENT, if any.
        enum (dict[str, Any] | None): declared enum type and labels, if the
            column's type is an enum.
        stats (dict[str, Any] | None): the pg_stats row, if ANALYZE has run.
    """
    entry: dict[str, Any] = {
        "name": column["name"],
        "expr": column["name"],
        "data_type": enum["type"] if enum else column["type"],
    }
    if comment:
        entry["description"] = comment
    if enum:
        entry["is_enum"] = True
        entry["sample_values"] = enum["labels"][:SAMPLE_VALUES_LIMIT]
    elif stats and stats["most_common_vals"]:
        # most_common_vals is null for high-cardinality columns, so this
        # self-selects the ones where example values actually help.
        entry["sample_values"] = (
            stats["most_common_vals"][:SAMPLE_VALUES_LIMIT])
    return entry


def build_relationships(foreign_keys: list[dict[str, Any]], schema: str,
                        name: str) -> list[dict[str, Any]]:
    """Render foreign keys as semantic relationships.

    Args:
        foreign_keys (list[dict[str, Any]]): entries from fetch_foreign_keys.
        schema (str): the owning schema.
        name (str): the owning entity.
    """
    relationships: list[dict[str, Any]] = []
    for fk in foreign_keys:
        ref = fk["references"]
        relationships.append({
            "left_table":
            f"{schema}.{name}",
            "right_table":
            f"{ref['schema']}.{ref['table']}",
            "relationship_columns": [{
                "left_column": left,
                "right_column": right,
            } for left, right in zip(fk["columns"], ref["columns"])],
        })
    return relationships


async def build_entity_semantic_json(accessor: PostgresAccessor, schema: str,
                                     name: str, kind: str) -> dict[str, Any]:
    """Build the derived semantic model for one entity.

    Uses the Snowflake semantic view field vocabulary so the artifact is
    familiar to models and interchangeable with a curated one. Everything
    here is derived from the catalog; synonyms, metrics and verified
    queries have no catalog source and are left for a curated overlay.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        name (str): the entity name.
        kind (str): "table" or "view".
    """
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        columns = await _client.fetch_columns(conn, schema, name)
        pk = await _client.fetch_primary_key(conn, schema, name)
        fks = await _client.fetch_foreign_keys(conn, schema, name)
        table_comment = await _client.fetch_table_comment(conn, schema, name)
        comments = await _client.fetch_column_comments(conn, schema, name)
        enums = await _client.fetch_enum_columns(conn, schema, name)
        stats = await _client.fetch_column_stats(conn, schema, name)

    key_columns = set(pk)
    for fk in fks:
        key_columns.update(fk["columns"])

    buckets: dict[str, list[dict[str, Any]]] = {
        "dimensions": [],
        "time_dimensions": [],
        "facts": [],
    }
    for column in columns:
        role = classify_column(column["name"], column["type"], key_columns)
        buckets[role].append(
            build_column_entry(column, comments.get(column["name"]),
                               enums.get(column["name"]),
                               stats.get(column["name"])))

    doc: dict[str, Any] = {
        "name": name,
        "schema": schema,
        "kind": kind,
    }
    if table_comment:
        doc["description"] = table_comment
    if pk:
        doc["primary_key"] = pk
    for role in ("dimensions", "time_dimensions", "facts"):
        if buckets[role]:
            doc[role] = buckets[role]
    relationships = build_relationships(fks, schema, name)
    if relationships:
        doc["relationships"] = relationships
    return doc
