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

from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.core.postgres import _client


@pytest.fixture
def mock_conn():
    conn = MagicMock()
    conn.fetch = AsyncMock()
    conn.fetchval = AsyncMock()
    conn.fetchrow = AsyncMock()
    return conn


def test_quote_ident_escapes_embedded_quotes():
    assert _client.quote_ident("users") == '"users"'
    assert _client.quote_ident('a"b') == '"a""b"'


def test_qualified_composes_both_parts():
    assert _client.qualified("public", "users") == '"public"."users"'


def test_quote_ident_neutralizes_injection():
    payload = 'books" CROSS JOIN secret AS "s'
    quoted = _client.quote_ident(payload)
    # Every embedded quote is doubled, so the payload cannot terminate the
    # identifier and become executable SQL: it stays one (nonexistent) name.
    assert quoted == '"books"" CROSS JOIN secret AS ""s"'
    # After stripping the outer wrapper and collapsing every doubled-quote
    # pair, no lone quote survives to break out of the identifier.
    assert '"' not in quoted[1:-1].replace('""', "")


def test_canonicalize_value_drops_trailing_zero_on_whole_floats():
    # Postgres renders a whole-valued double as `5` (to_jsonb), and node-pg
    # gives JS number 5; asyncpg gives Python float 5.0 which orjson would
    # print as `5.0`. Canonicalizing to int keeps py rows.jsonl byte-identical
    # to ts (and to Postgres canonical JSON).
    assert _client.canonicalize_value(5.0) == 5
    assert isinstance(_client.canonicalize_value(5.0), int)
    assert _client.canonicalize_value(4.5) == 4.5
    assert isinstance(_client.canonicalize_value(4.5), float)


def test_canonicalize_value_leaves_non_floats_and_specials():
    assert _client.canonicalize_value(True) is True
    assert _client.canonicalize_value("5.0") == "5.0"
    assert _client.canonicalize_value(float("inf")) == float("inf")


def test_canonicalize_row_recurses_into_nested_structures():
    row = {"r": 5.0, "tags": [1.0, 2.5], "meta": {"n": 3.0}}
    assert _client.canonicalize_row(row) == {
        "r": 5,
        "tags": [1, 2.5],
        "meta": {
            "n": 3
        },
    }


@pytest.mark.asyncio
async def test_count_rows_quotes_a_malicious_name(mock_conn):
    mock_conn.fetchval.return_value = 0
    await _client.count_rows(mock_conn, "public",
                             'books" CROSS JOIN secret AS "s')
    sql = mock_conn.fetchval.call_args.args[0]
    assert '"books"" CROSS JOIN secret AS ""s"' in sql
    assert 'FROM "public"."books" CROSS JOIN secret' not in sql


@pytest.mark.asyncio
async def test_list_schemas(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "schema_name": "analytics"
        },
        {
            "schema_name": "public"
        },
    ]
    result = await _client.list_schemas(mock_conn, None)
    assert result == ["analytics", "public"]


@pytest.mark.asyncio
async def test_list_schemas_allowlist(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "schema_name": "public"
        },
        {
            "schema_name": "analytics"
        },
    ]
    result = await _client.list_schemas(mock_conn, ["public"])
    assert result == ["public"]


@pytest.mark.asyncio
async def test_list_tables(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "table_name": "v1"
        },
        {
            "table_name": "v2"
        },
    ]
    result = await _client.list_tables(mock_conn, "public")
    assert result == ["v1", "v2"]


@pytest.mark.asyncio
async def test_list_views(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "table_name": "v1"
        },
        {
            "table_name": "v2"
        },
    ]
    result = await _client.list_views(mock_conn, "public")
    assert result == ["v1", "v2"]


@pytest.mark.asyncio
async def test_list_matviews(mock_conn):
    mock_conn.fetch.return_value = [{"name": "mv1"}]
    result = await _client.list_matviews(mock_conn, "public")
    assert result == ["mv1"]


@pytest.mark.asyncio
async def test_count_rows(mock_conn):
    mock_conn.fetchval.return_value = 42
    result = await _client.count_rows(mock_conn, "public", "users")
    assert result == 42


@pytest.mark.asyncio
async def test_estimate_size(mock_conn):
    mock_conn.fetchval.return_value = [{
        "Plan": {
            "Plan Rows": 1234,
            "Plan Width": 80
        }
    }]
    result = await _client.estimate_size(mock_conn, "public", "users")
    assert result == (1234, 80)


@pytest.mark.asyncio
async def test_estimate_size_json_string(mock_conn):
    mock_conn.fetchval.return_value = (
        '[{"Plan": {"Plan Rows": 500, "Plan Width": 64}}]')
    rows, width = await _client.estimate_size(mock_conn, "public", "v1")
    assert rows == 500
    assert width == 64


@pytest.mark.asyncio
async def test_estimated_row_count(mock_conn):
    mock_conn.fetchval.return_value = 9999
    result = await _client.estimated_row_count(mock_conn, "public", "users")
    assert result == 9999


@pytest.mark.asyncio
async def test_estimated_row_count_none(mock_conn):
    mock_conn.fetchval.return_value = None
    result = await _client.estimated_row_count(mock_conn, "public", "users")
    assert result == 0


@pytest.mark.asyncio
async def test_table_size_bytes(mock_conn):
    mock_conn.fetchval.return_value = 2_097_152
    result = await _client.table_size_bytes(mock_conn, "public", "users")
    assert result == 2097152


@pytest.mark.asyncio
async def test_fetch_rows(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "id": 1,
            "name": "a"
        },
        {
            "id": 2,
            "name": "b"
        },
    ]
    result = await _client.fetch_rows(mock_conn,
                                      "public",
                                      "users",
                                      limit=10,
                                      offset=0)
    assert len(result) == 2
    assert result[0]["name"] == "a"


@pytest.mark.asyncio
async def test_fetch_columns(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "column_name": "id",
            "data_type": "uuid",
            "is_nullable": "NO"
        },
        {
            "column_name": "team_id",
            "data_type": "uuid",
            "is_nullable": "YES",
        },
    ]
    result = await _client.fetch_columns(mock_conn, "public", "users")
    assert result == [
        {
            "name": "id",
            "type": "uuid",
            "nullable": False
        },
        {
            "name": "team_id",
            "type": "uuid",
            "nullable": True
        },
    ]


@pytest.mark.asyncio
async def test_fetch_primary_key(mock_conn):
    mock_conn.fetch.return_value = [{"column_name": "id"}]
    result = await _client.fetch_primary_key(mock_conn, "public", "users")
    assert result == ["id"]


@pytest.mark.asyncio
async def test_fetch_foreign_keys(mock_conn):
    mock_conn.fetch.return_value = [{
        "constraint_name": "fk1",
        "from_column": "team_id",
        "ordinal_position": 1,
        "to_schema": "public",
        "to_table": "teams",
        "to_column": "id",
    }]
    result = await _client.fetch_foreign_keys(mock_conn, "public", "users")
    assert result == [{
        "columns": ["team_id"],
        "references": {
            "schema": "public",
            "table": "teams",
            "columns": ["id"],
        },
    }]


@pytest.mark.asyncio
async def test_fetch_foreign_keys_multi_column(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "constraint_name": "fk_compound",
            "from_column": "tenant_id",
            "to_column": "tenant_id",
            "ord": 1,
            "to_schema": "public",
            "to_table": "accounts",
        },
        {
            "constraint_name": "fk_compound",
            "from_column": "user_id",
            "to_column": "id",
            "ord": 2,
            "to_schema": "public",
            "to_table": "accounts",
        },
    ]
    result = await _client.fetch_foreign_keys(mock_conn, "public",
                                              "memberships")
    assert result == [{
        "columns": ["tenant_id", "user_id"],
        "references": {
            "schema": "public",
            "table": "accounts",
            "columns": ["tenant_id", "id"],
        },
    }]


@pytest.mark.asyncio
async def test_fetch_indexes(mock_conn):
    mock_conn.fetch.return_value = [{
        "name": "users_email_idx",
        "unique": True,
        "columns": ["email"],
    }]
    result = await _client.fetch_indexes(mock_conn, "public", "users")
    assert result == [{
        "name": "users_email_idx",
        "columns": ["email"],
        "unique": True,
    }]


@pytest.mark.asyncio
async def test_fetch_all_relationships(mock_conn):
    mock_conn.fetch.return_value = [{
        "constraint_name": "fk1",
        "from_schema": "public",
        "from_table": "users",
        "from_column": "team_id",
        "ordinal_position": 1,
        "to_schema": "public",
        "to_table": "teams",
        "to_column": "id",
    }]
    result = await _client.fetch_all_relationships(mock_conn, ["public"])
    assert len(result) == 1
    assert result[0]["kind"] == "many_to_one"
    assert result[0]["from"] == {
        "schema": "public",
        "table": "users",
        "columns": ["team_id"],
    }
    assert result[0]["to"] == {
        "schema": "public",
        "table": "teams",
        "columns": ["id"],
    }


@pytest.mark.asyncio
async def test_fetch_all_relationships_multi_column(mock_conn):
    mock_conn.fetch.return_value = [
        {
            "constraint_name": "fk_compound",
            "from_schema": "public",
            "from_table": "memberships",
            "from_column": "tenant_id",
            "to_column": "tenant_id",
            "ord": 1,
            "to_schema": "public",
            "to_table": "accounts",
        },
        {
            "constraint_name": "fk_compound",
            "from_schema": "public",
            "from_table": "memberships",
            "from_column": "user_id",
            "to_column": "id",
            "ord": 2,
            "to_schema": "public",
            "to_table": "accounts",
        },
    ]
    result = await _client.fetch_all_relationships(mock_conn, ["public"])
    assert len(result) == 1
    assert result[0]["kind"] == "many_to_one"
    assert result[0]["from"] == {
        "schema": "public",
        "table": "memberships",
        "columns": ["tenant_id", "user_id"],
    }
    assert result[0]["to"] == {
        "schema": "public",
        "table": "accounts",
        "columns": ["tenant_id", "id"],
    }


@pytest.mark.asyncio
async def test_fetch_all_relationships_empty_schemas(mock_conn):
    result = await _client.fetch_all_relationships(mock_conn, [])
    assert result == []
    mock_conn.fetch.assert_not_called()
